---
name: opencode-protocol
description: OpenCode SSE/HTTP protocol contract for the OpenCodeFixBackend in this repo. Read BEFORE editing any file under src/backends/opencode*, src/backends/openCodeFixBackend.ts, or test/fixtures/llm-scenarios/. Anchored to evidence captured against opencode 1.14.25 + @opencode-ai/sdk@1.3.2 (see events/ and references/). Covers wire format, terminal predicate, transport modes, full event catalog, endpoint list, and known traps.
---

# OpenCode Protocol Contract

This skill is the source of truth for the OpenCode wire protocol as observed
locally. It supersedes any guess from training data or from
`test/fixtures/llm-scenarios/` (those fixtures use an adapter-normalized shape,
not wire format).

## Evidence

- `events/captured-prompt-cycle.sse.txt` — real SSE stream of a prompt sent to
  Moonshot (kimi-k2.6), captured 2026-04-26 against opencode 1.14.25.
- `events/captured-idle-baseline.sse.txt` — initial events on a fresh `/event`
  subscription with no prompt activity.
- `references/sdk-event-union.md` — full discriminator list extracted from
  `@opencode-ai/sdk@1.3.2/dist/gen/types.gen.d.ts`.
- `references/security.md` — auth-related findings.
- `references/how-to-recapture.md` — procedure to re-verify when opencode upgrades.

If you doubt anything below, re-run the capture procedure in
`references/how-to-recapture.md`.

## Hard Rules — Violating These = Bug

### R1. Wire format is `{type, properties}`, NOT `{type, part}` / `{type, tool_call}`

Every SSE frame is `data: <one-line JSON>` followed by a blank line. The JSON
is always a flat envelope:

```json
{"type": "<dotted.name>", "properties": { ... }}
```

There is no `event:` line, no nested `event` field, no `part`/`tool_call`/
`tool_result` shortcuts at the top level. Those shapes only exist in
`opencodeEventAdapter.ts` after normalization.

### R2. The terminal predicate is `message.updated` with `info.time.completed`

The assistant turn is finished when, and only when, you observe a
`message.updated` event whose `properties.info.role === "assistant"` and
`properties.info.time.completed !== undefined`. Read `info.error` to decide
success vs failure; read `info.finish` for the stop reason on success.

These signals do **NOT** mean the turn is done:

| Signal | Why it is not terminal |
|---|---|
| `session.idle` | Fires AFTER errors, AFTER aborts, AFTER success — and can fire multiple times. Pure "not busy right now" broadcast. |
| `session.status` with `status.type === "idle"` | Same as above. |
| `server.heartbeat` | Keep-alive; not in SDK union but server emits it. Continues forever after the message has finished. |
| `server.disconnect` / TCP close | Soft-close. Means transport gone, not that the model committed a final answer. |
| `session.diff` with non-empty `diff` | Indicates files changed, not that the model is done. |
| Stdout EOF (acp mode) | Same — transport-level, not protocol-level. |
| A code-block in a `message.part.updated` text | The model can still emit more parts. Never write to disk on partial text. |

### R3. Transport disposal happens AFTER `session.run()` settles

Never `dispose()` the transport from inside an event handler. Keep
`opencodeSession.run()` returning a promise that only resolves once R2's
terminal predicate has fired (or a hard error occurred), and only then
dispose the transport from the caller (`openCodeFixBackend.ts`).

### R4. Tool calls are ToolPart with state machine, not separate events

A tool invocation arrives as `message.part.updated` events whose
`properties.part.type === "tool"`. The same `callID` part is updated multiple
times as `state.type` transitions:

```
pending --> running --> completed
                    \-> error
```

Disk-level finalize requires:
- a `ToolPart` for an edit-style tool (e.g. `edit_file`) with
  `state.type === "completed"` and no error, AND
- a real disk diff confirming the file changed.

A user-visible "Done." text part alone is not enough.

### R5. `prompt_async` is fire-and-forget; subscribe to `/event` FIRST

```
1. open SSE on  GET /event
2. POST /session                       returns {id: "ses_..."}
3. POST /session/{id}/prompt_async     returns 204 No Content
4. consume events from step 1 until R2 terminal predicate
```

Step 1 must precede step 3, otherwise events emitted between session
creation and SSE subscription are lost.

### R6. `/doc` is incomplete — never trust it as the API surface

OpenCode 1.14.25 ships an OpenAPI document at `GET /doc` that declares only
2 paths (`/auth/{providerID}` and `/log`). The real surface is 19+ paths;
authoritative list is in `references/sdk-event-union.md` (extracted from the
SDK type generation, not the OpenAPI).

## Transport Modes

Only two are supported. Don't add anything back.

| Mode | Trigger | Wire |
|---|---|---|
| `server` | `msagent.opencodeMode = "server"` | HTTP on `127.0.0.1:<opencodeServePort>`, SSE on `GET /event`, prompt via `POST /session/{id}/prompt_async` |
| `acp` | `msagent.opencodeMode = "acp"` | stdio JSON-RPC against `opencodeCliPath` with `opencodeAcpArgs` |

No `cli`, no `api`. They were removed and must not return.

## Endpoint Catalog (server mode)

Extracted from `@opencode-ai/sdk@1.3.2`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/event` | SSE event stream — subscribe before sending prompts |
| POST | `/log` | Append a structured log entry |
| GET | `/session` | List sessions |
| POST | `/session` | Create session, returns `{id, slug, version, projectID, directory, title, time}` |
| GET | `/session/{id}` | Session detail (includes `summary` after activity) |
| GET | `/session/status` | Bulk session status |
| POST | `/session/{id}/abort` | Abort active prompt |
| GET / POST | `/session/{id}/message` | List or post messages (sync prompt path) |
| GET | `/session/{id}/message/{messageID}` | Single message detail |
| POST | `/session/{id}/prompt_async` | Fire-and-forget prompt → events arrive via `/event` |
| POST | `/session/{id}/init` `/fork` `/share` `/summarize` `/revert` `/unrevert` | Session ops |
| POST | `/session/{id}/command` `/shell` | Command/shell execution |
| GET | `/session/{id}/diff` `/children` `/todo` | Auxiliary reads |
| PUT | `/session/{id}/permissions/{permissionID}` | Reply to a permission prompt |
| GET | `/config` | **LEAKS API KEYS** — see references/security.md |
| GET | `/provider` | **LEAKS API KEYS** — see references/security.md |
| GET | `/agent` | List configured agents (large) |
| GET | `/command` | List configured commands (large) |
| GET / PUT / DELETE | `/auth/{providerID}` | Manage stored credentials |

## Event Catalog (32 documented + 1 undocumented)

Documented (from SDK type union):

```
server.connected               server.instance.disposed
installation.updated           installation.update-available
lsp.client.diagnostics         lsp.updated
message.updated                message.removed
message.part.updated           message.part.removed
permission.updated             permission.replied
session.status                 session.idle
session.compacted              session.created
session.updated                session.deleted
session.diff                   session.error
file.edited                    file.watcher.updated
todo.updated                   command.executed
vcs.branch.updated
tui.prompt.append              tui.command.execute
tui.toast.show
pty.created                    pty.updated
pty.exited                     pty.deleted
```

Undocumented but emitted in practice:

```
server.heartbeat
```

Adapter must therefore tolerate unknown `type` values (default = ignore, do
not throw, do not treat as terminal).

## Part Type Catalog

`Part = TextPart | SubtaskPart | ReasoningPart | FilePart | ToolPart |
StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart |
RetryPart | CompactionPart`

Eleven variants. Discriminated by `part.type`. The repo's tool-chain logic
must understand `type === "tool"` (with internal state machine) and
`type === "step-finish"` (carries cost/tokens accounting and `reason`).

Common mistake to avoid: treating a single text part containing a fenced
code block as a tool action. It is not. Real edits go through `ToolPart`.

## Known Traps (do NOT regress)

| Trap | Witness | Symptom if missed |
|---|---|---|
| Treat `session.idle` as success | events/captured-prompt-cycle.sse.txt event 14 fires AFTER an error | partial/wrong patch written to disk on a failed turn |
| Treat `session.diff` with `files=0` as "files changed" | event 10 in the captured cycle is empty | finalize bails out wrongly or writes nothing |
| Drop unknown event `server.heartbeat` with an exception | not in SDK union | session loop dies on keep-alive |
| Build code-block guard from text alone | model can pause mid-emission | placeholder/stub written over real source |
| Dispose transport before `session.run()` settles | racing finalize against pending events | "session terminated early" with truncated patch |
| Trust `/doc` for endpoint list | only 2 of 19+ paths | missing routes; PRs that "remove unused endpoints" wrongly |

## Pre-Edit Checklist

Before touching ANY of these files:

- `src/backends/opencodeTransport.ts`
- `src/backends/opencodeSession.ts`
- `src/backends/opencodeEventAdapter.ts`
- `src/backends/openCodeFixBackend.ts`
- `test/fixtures/llm-scenarios/*.json`

You MUST:

1. Read this SKILL.md plus the relevant capture in `events/`.
2. State, in your plan, which Hard Rule (R1–R6) and which Trap your change
   touches.
3. If adding a new event type to the adapter, cite the SDK schema in
   `references/sdk-event-union.md` (do not invent type names).
4. If changing finalize logic, add a new fixture to
   `test/fixtures/llm-scenarios/` covering the case BEFORE writing
   implementation. The fixture must be expressible in the same JSON-step
   format as existing scenarios; the underlying wire shape must match R1.
5. Run `npm test -- --grep opencode` and confirm green before AND after the
   change.

## Quick Reference: Minimal Wire Cycle

```
GET  /event                                     -> 200 text/event-stream
                                                  data: {"type":"server.connected","properties":{}}

POST /session                                   -> 200 {"id":"ses_<X>", ...}

POST /session/<X>/prompt_async                  -> 204 No Content
     body: { "model": {"providerID","modelID"},
             "parts": [{"type":"text","text":"..."}] }

(events on /event)
  data: {"type":"session.created", ...}
  data: {"type":"message.updated",
         "properties":{"info":{"role":"user", ...}}}
  data: {"type":"message.part.updated",
         "properties":{"part":{"type":"text", ...}}}
  data: {"type":"session.status",
         "properties":{"status":{"type":"busy"}}}
  data: {"type":"message.updated",
         "properties":{"info":{"role":"assistant",
                               "time":{"created":...}}}}
  ... message.part.updated x N (text deltas, tool parts) ...
  data: {"type":"message.updated",                   # TERMINAL
         "properties":{"info":{"role":"assistant",
                               "time":{"created":...,"completed":...},
                               "finish":"stop"}}}
  data: {"type":"session.status",
         "properties":{"status":{"type":"idle"}}}    # post-terminal noise
  data: {"type":"session.idle", ...}                 # post-terminal noise
  data: {"type":"server.heartbeat","properties":{}}  # keep-alive forever
```

The terminal frame is the assistant `message.updated` with
`time.completed`. Everything after it is informational.
