---
name: opencode-session-debugger
description: Debug OpenCode behavior by session id using the local OpenCode SQLite database and optional debug logs. Use this skill whenever the user gives an OpenCode session id, asks why Fix Details showed "Explanation unavailable", wants to confirm whether OpenCode really returned text, asks to inspect a patch/tool-only run, or needs to trace session/message/part records for applied-fix, aborted, no-change, or protocol-edge cases.
---

# opencode-session-debugger

Use this skill to investigate what OpenCode actually produced for a specific run.

This skill is especially useful when UI symptoms are ambiguous, for example:

- "Explanation unavailable"
- a successful fix now shows a synthetic explanation and you need to confirm whether OpenCode actually persisted any assistant text
- a patch applied but the explanation card is empty
- the run looks aborted after a successful edit
- a session appears to have finished with tools only
- a user wants proof from the OpenCode database instead of the extension logs

The goal is to answer a concrete question with evidence:

- Did OpenCode store any assistant text for this session?
- Was the run tool-only?
- Did a follow-up assistant message abort after the patch already landed?
- Is the missing explanation a product bug, an OpenCode behavior gap, or a UI extraction bug?

## Inputs

You usually need:

- an OpenCode `session id`, such as `ses_...`
- the repo root, if you want to compare with msAgent code paths

Optional but helpful:

- a debug log path such as `/tmp/open-island-opencode-debug.log`
- a target file path that was edited
- the exact UI symptom the user saw

## Default data sources

Check these in order:

1. SQLite database: `$HOME/.local/share/opencode/opencode.db`
2. Optional registry: `$HOME/Library/Application Support/open-island/opencode-session-registry.json`
3. Optional debug logs:
   - `/tmp/open-island-opencode-debug.log`
   - any user-provided log path

Do not assume the database is under `~/.opencode`. That directory often holds the CLI install, not the runtime data store.

## Fast path

Run:

```bash
python .agents/skills/opencode-session-debugger/scripts/opencode_session_trace.py \
  --session-id ses_example \
  --include-log /tmp/open-island-opencode-debug.log
```

If the user asked for machine-readable output:

```bash
python .agents/skills/opencode-session-debugger/scripts/opencode_session_trace.py \
  --session-id ses_example \
  --include-log /tmp/open-island-opencode-debug.log \
  --format json
```

## What the script does

It queries the OpenCode database for:

- `session`
- `message`
- `part`
- `session_message`

Then it summarizes:

- assistant/user messages
- tool calls and their statuses
- assistant text parts
- reasoning parts
- message errors such as `MessageAbortedError`
- likely explanations for missing UI text

It also optionally scans debug logs for the same `session id`.

## Investigation workflow

### 1. Confirm the session exists

If the session is missing from the DB:

- say that clearly
- check the debug log next
- do not guess whether the run succeeded

Possible interpretations:

- wrong session id
- a different local profile/database
- the run happened on another machine or account

### 2. Compare assistant messages vs assistant text parts

This is the key distinction.

An assistant message with `time.completed` does **not** guarantee there was any human-readable explanation text.

Look for:

- assistant `message` rows
- assistant `part` rows with `type="text"` and non-empty text
- assistant `part` rows with only `tool`, `step-start`, `step-finish`, or empty `reasoning`

If there are no assistant text parts, and the patch landed through a tool call, then the underlying OpenCode run is missing a persisted explanation. In current msAgent builds that usually means the UI should show a synthetic fallback instead of `Explanation unavailable`.

### 3. Check whether the session was tool-only

Common tool-only pattern:

- one assistant message
- `finish="tool-calls"`
- completed `apply_patch`
- no non-empty assistant text parts
- optional follow-up assistant message with `MessageAbortedError`

This usually means OpenCode executed the fix but never persisted a narrative explanation.

### 4. Inspect aborted follow-up behavior

If you see:

- a successful tool call
- then a second assistant message with `error.name="MessageAbortedError"`

report both facts separately:

- the edit still landed
- the later explanation phase aborted

That is not the same as "the whole repair failed."

### 5. Check `session_message`

If `session_message` is empty, say so explicitly.

That matters because it rules out the possibility that msAgent merely failed to read a session-level explanation summary.

### 6. Cross-check debug logs

Use logs when you need extra timing or event-order detail:

- `message.updated`
- `message.part.updated`
- `session.error`
- `session.idle`
- `file.edited`

Logs are helpful for sequencing.
The DB is the stronger source for "what was actually persisted."

## Common diagnoses

### A. Missing explanation confirmed

Use this when:

- file changed or patch tool completed
- no assistant text parts exist
- `session_message` is empty

Conclusion:

- the missing explanation originated in OpenCode output persistence, not msAgent rendering
- older msAgent builds may show `Explanation unavailable`
- current msAgent builds should synthesize a three-part explanation from the diagnostic and diff

### B. Tool-only apply without natural-language follow-up

Use this when:

- `apply_patch` completed
- assistant message finished with `finish="tool-calls"`
- no text parts exist

Conclusion:

- OpenCode did a pure tool execution path
- msAgent can only show a synthetic fallback or a patch-derived explanation

### C. Aborted follow-up after successful patch

Use this when:

- patch landed
- a later assistant message contains `MessageAbortedError`

Conclusion:

- the repair likely succeeded
- the narrative explanation phase was interrupted

### D. Session present in logs but not in DB

Use this when:

- log hits exist
- no DB rows exist

Conclusion:

- investigate profile/path mismatches or persistence failures before blaming explanation extraction

### E. Explanation exists but UI still missed it

Use this when:

- non-empty assistant text parts or session messages do exist
- UI still showed "Explanation unavailable"

Conclusion:

- this is a real extraction or rendering bug
- include the message id / part id that contained the missed text

## How to report findings

Prefer this structure:

1. Verdict
2. Evidence from DB
3. Evidence from logs
4. What msAgent did correctly or incorrectly
5. Suggested next fix

Example wording:

- "The fallback is accurate for this session. OpenCode persisted a completed `apply_patch`, but there are no non-empty assistant text parts and no `session_message` rows."
- "This is not just a UI issue. The database confirms the explanation was never stored."
- "The patch landed first, then a later assistant message aborted with `MessageAbortedError`, so the repair and the explanation phase diverged."
- "OpenCode never stored a narrative explanation for this patch. The current UI should therefore rely on a synthetic `Problem / Fix / Why it works` explanation."

## Follow-up actions this skill should suggest when useful

- add a patch-derived fallback explanation in msAgent
- improve the UI copy to distinguish "tool-only success" from "OpenCode returned no explanation"
- add a regression fixture for sessions with:
  - completed patch + no assistant text
  - completed patch + aborted follow-up assistant message
  - explanation present in DB but missed by UI

Note: the first follow-up is already implemented in current msAgent builds. If the UI still shows `Explanation unavailable` for a successful fix, treat that as a regression.

## Files in this skill

- `scripts/opencode_session_trace.py`

Use the script first, then inspect repo code only if you need to explain whether msAgent handled the trace correctly.
