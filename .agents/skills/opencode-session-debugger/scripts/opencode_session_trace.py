#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any


DEFAULT_DB = Path.home() / ".local" / "share" / "opencode" / "opencode.db"
DEFAULT_LOGS = [
    Path("/tmp/open-island-opencode-debug.log"),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect an OpenCode session by session id using the local SQLite database and optional debug logs.",
    )
    parser.add_argument("--session-id", required=True, help="OpenCode session id, e.g. ses_...")
    parser.add_argument("--db-path", default=str(DEFAULT_DB), help="Path to opencode.db")
    parser.add_argument(
        "--include-log",
        action="append",
        default=[],
        help="Optional log file to scan for matching session id. Can be repeated.",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )
    parser.add_argument(
        "--max-log-hits",
        type=int,
        default=40,
        help="Maximum matching log lines to include",
    )
    return parser.parse_args()


def load_json(value: str | None) -> Any:
    if not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def query_all(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...]) -> list[dict[str, Any]]:
    conn.row_factory = sqlite3.Row
    rows = conn.execute(sql, params).fetchall()
    return [dict(row) for row in rows]


def normalize_message(row: dict[str, Any]) -> dict[str, Any]:
    data = load_json(row.get("data"))
    role = None
    finish = None
    completed = None
    error = None
    if isinstance(data, dict):
        role = data.get("role")
        finish = data.get("finish")
        time = data.get("time")
        if isinstance(time, dict):
            completed = time.get("completed")
        error = data.get("error")
    return {
        "id": row["id"],
        "time_created": row["time_created"],
        "time_updated": row["time_updated"],
        "role": role,
        "finish": finish,
        "completed": completed,
        "error": error,
        "data": data,
    }


def normalize_part(row: dict[str, Any]) -> dict[str, Any]:
    data = load_json(row.get("data"))
    part_type = None
    text = None
    tool = None
    tool_status = None
    call_id = None
    metadata = None
    if isinstance(data, dict):
        part_type = data.get("type")
        text = data.get("text")
        tool = data.get("tool")
        call_id = data.get("callID")
        state = data.get("state")
        if isinstance(state, dict):
            tool_status = state.get("status")
        metadata = data.get("metadata")
    return {
        "id": row["id"],
        "message_id": row["message_id"],
        "time_created": row["time_created"],
        "time_updated": row["time_updated"],
        "type": part_type,
        "text": text,
        "tool": tool,
        "tool_status": tool_status,
        "call_id": call_id,
        "metadata": metadata,
        "data": data,
    }


def detect_diagnoses(
    session_exists: bool,
    messages: list[dict[str, Any]],
    parts: list[dict[str, Any]],
    session_messages: list[dict[str, Any]],
) -> list[str]:
    diagnoses: list[str] = []
    if not session_exists:
        diagnoses.append("session_missing_from_db")
        return diagnoses

    assistant_messages = [m for m in messages if m.get("role") == "assistant"]
    assistant_parts = [
        p for p in parts
        if any(m["id"] == p["message_id"] and m.get("role") == "assistant" for m in assistant_messages)
    ]
    assistant_text_parts = [
        p for p in assistant_parts
        if p.get("type") == "text" and isinstance(p.get("text"), str) and p["text"].strip()
    ]
    reasoning_parts = [p for p in assistant_parts if p.get("type") == "reasoning"]
    empty_reasoning = [
        p for p in reasoning_parts
        if not isinstance(p.get("text"), str) or not p["text"].strip()
    ]
    completed_tool_parts = [
        p for p in assistant_parts
        if p.get("type") == "tool" and p.get("tool_status") == "completed"
    ]
    completed_apply_patch = [p for p in completed_tool_parts if p.get("tool") == "apply_patch"]
    aborted_assistant = [
        m for m in assistant_messages
        if isinstance(m.get("error"), dict) and m["error"].get("name") == "MessageAbortedError"
    ]
    tool_call_finish = [
        m for m in assistant_messages
        if m.get("finish") == "tool-calls" and m.get("completed")
    ]

    if completed_apply_patch and not assistant_text_parts and not session_messages:
        diagnoses.append("missing_explanation_confirmed")
    if completed_apply_patch and tool_call_finish and not assistant_text_parts:
        diagnoses.append("tool_only_apply_without_explanation")
    if completed_apply_patch and aborted_assistant:
        diagnoses.append("aborted_followup_after_patch")
    if empty_reasoning and not assistant_text_parts:
        diagnoses.append("empty_reasoning_only")
    if assistant_text_parts:
        diagnoses.append("assistant_text_present")
    if session_messages:
        diagnoses.append("session_message_present")
    return diagnoses


def summarize_patch(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    patches: list[dict[str, Any]] = []
    for part in parts:
        if part.get("type") != "tool" or part.get("tool") != "apply_patch":
            continue
        data = part.get("data")
        state = data.get("state") if isinstance(data, dict) else None
        input_data = state.get("input") if isinstance(state, dict) else None
        metadata = state.get("metadata") if isinstance(state, dict) else None
        patch_text = input_data.get("patchText") if isinstance(input_data, dict) else None
        diff_text = metadata.get("diff") if isinstance(metadata, dict) else None
        patches.append(
            {
                "part_id": part.get("id"),
                "message_id": part.get("message_id"),
                "status": part.get("tool_status"),
                "call_id": part.get("call_id"),
                "patch_text": patch_text,
                "diff_text": diff_text,
            }
        )
    return patches


def scan_logs(session_id: str, log_paths: list[Path], max_hits: int) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    for log_path in log_paths:
        if not log_path.exists():
            continue
        try:
            with log_path.open("r", encoding="utf-8", errors="replace") as handle:
                for lineno, line in enumerate(handle, start=1):
                    if session_id in line:
                        hits.append(
                            {
                                "path": str(log_path),
                                "line": lineno,
                                "text": line.rstrip("\n"),
                            }
                        )
                        if len(hits) >= max_hits:
                            return hits
        except OSError:
            continue
    return hits


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    db_path = Path(args.db_path).expanduser()
    report: dict[str, Any] = {
        "session_id": args.session_id,
        "db_path": str(db_path),
        "db_exists": db_path.exists(),
    }

    log_paths = [Path(p).expanduser() for p in args.include_log]
    for candidate in DEFAULT_LOGS:
        if candidate not in log_paths:
            log_paths.append(candidate)

    if not db_path.exists():
        report["error"] = f"Database not found: {db_path}"
        report["log_hits"] = scan_logs(args.session_id, log_paths, args.max_log_hits)
        report["diagnoses"] = ["db_missing"]
        return report

    conn = sqlite3.connect(str(db_path))
    try:
        session_rows = query_all(
            conn,
            """
            select id, project_id, title, directory, version, agent, model,
                   time_created, time_updated
            from session
            where id = ?
            """,
            (args.session_id,),
        )
        message_rows = query_all(
            conn,
            """
            select id, time_created, time_updated, data
            from message
            where session_id = ?
            order by time_created
            """,
            (args.session_id,),
        )
        part_rows = query_all(
            conn,
            """
            select id, message_id, time_created, time_updated, data
            from part
            where session_id = ?
            order by time_created
            """,
            (args.session_id,),
        )
        session_message_rows = query_all(
            conn,
            """
            select id, type, time_created, time_updated, data
            from session_message
            where session_id = ?
            order by time_created
            """,
            (args.session_id,),
        )
    finally:
        conn.close()

    messages = [normalize_message(row) for row in message_rows]
    parts = [normalize_part(row) for row in part_rows]
    assistant_message_ids = {message["id"] for message in messages if message.get("role") == "assistant"}
    assistant_text_parts = [
        {
            "id": part["id"],
            "message_id": part["message_id"],
            "text": part["text"],
        }
        for part in parts
        if part["message_id"] in assistant_message_ids
        and part.get("type") == "text"
        and isinstance(part.get("text"), str)
        and part["text"].strip()
    ]
    patches = summarize_patch(parts)
    diagnoses = detect_diagnoses(bool(session_rows), messages, parts, session_message_rows)
    log_hits = scan_logs(args.session_id, log_paths, args.max_log_hits)

    report.update(
        {
            "session": session_rows[0] if session_rows else None,
            "messages": messages,
            "parts": parts,
            "session_messages": [
                {
                    **row,
                    "data": load_json(row.get("data")),
                }
                for row in session_message_rows
            ],
            "assistant_text_parts": assistant_text_parts,
            "patches": patches,
            "diagnoses": diagnoses,
            "log_hits": log_hits,
        }
    )
    return report


def print_text(report: dict[str, Any]) -> None:
    print(f"Session: {report['session_id']}")
    print(f"DB: {report['db_path']}")
    if not report.get("db_exists"):
        print("Verdict: database missing")
        if report.get("log_hits"):
            print("Log hits:")
            for hit in report["log_hits"]:
                print(f"  {hit['path']}:{hit['line']}: {hit['text']}")
        return

    session = report.get("session")
    if not session:
        print("Verdict: session not found in database")
    else:
        print("Session row:")
        print(
            f"  title={session.get('title')} version={session.get('version')} "
            f"directory={session.get('directory')}"
        )

    diagnoses = report.get("diagnoses") or []
    if diagnoses:
        print("Diagnoses:")
        for item in diagnoses:
            print(f"  - {item}")

    print("Messages:")
    for message in report.get("messages", []):
        error = ""
        if isinstance(message.get("error"), dict):
            error = f" error={message['error'].get('name')}"
        print(
            f"  - {message['id']} role={message.get('role')} finish={message.get('finish')} "
            f"completed={message.get('completed')}{error}"
        )

    assistant_text_parts = report.get("assistant_text_parts", [])
    print(f"Assistant text parts: {len(assistant_text_parts)}")
    for part in assistant_text_parts[:5]:
        text = str(part.get("text", "")).strip().replace("\n", "\\n")
        if len(text) > 180:
            text = text[:177] + "..."
        print(f"  - {part['id']} message={part['message_id']} text={text}")

    patches = report.get("patches", [])
    print(f"Patch tool parts: {len(patches)}")
    for patch in patches[:3]:
        print(
            f"  - {patch.get('part_id')} call={patch.get('call_id')} "
            f"status={patch.get('status')}"
        )
        patch_text = patch.get("patch_text")
        if isinstance(patch_text, str):
            preview = patch_text.strip().splitlines()
            for line in preview[:8]:
                print(f"      {line}")
            if len(preview) > 8:
                print("      ...")

    session_messages = report.get("session_messages", [])
    print(f"Session messages: {len(session_messages)}")

    log_hits = report.get("log_hits", [])
    print(f"Log hits: {len(log_hits)}")
    for hit in log_hits[:10]:
        print(f"  {hit['path']}:{hit['line']}: {hit['text']}")


def main() -> int:
    args = parse_args()
    report = build_report(args)
    if args.format == "json":
        json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        print_text(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
