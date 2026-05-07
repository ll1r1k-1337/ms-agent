# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

## Project Overview

msAgent is a VS Code extension for parsing `mssanitizer --tool=memcheck` logs and repairing Ascend C / C++ memory issues through **OpenCode**.

The repository is now **OpenCode-only**:

- no built-in OpenAI-compatible backend
- no host-side custom tool executor
- no settings webview
- no OpenCode `cli`, `api`, or `acp` transport mode

## Build, Lint, and Test

| Command | Description |
|---|---|
| `npm install` | Install dependencies |
| `npm run compile` | Compile TypeScript |
| `npm run watch` | Watch mode |
| `npm run lint` | ESLint |
| `npm test` | Run unit and integration tests |
| `npm run test:coverage` | Run tests with coverage |

## Key Configuration

The extension reads settings from `workspace.getConfiguration('msagent')`.

- `msagent.modelName`
- `msagent.timeoutMs`
- `msagent.opencodeServePort`
- `msagent.opencodeCliPath`

## Source Code Architecture

```text
src/
├── extension.ts                    # Command registration and lifecycle
├── parser/
│   ├── types.ts                    # Sanitizer types
│   └── logParser.ts                # Log parser
├── llm/
│   ├── config.ts                   # VS Code config reader
│   ├── configResolver.ts           # OpenCode-only config normalization
│   └── types.ts                    # Stream chunk types
├── backends/
│   ├── fixBackend.ts               # Backend interface
│   ├── backendFactory.ts           # Always returns OpenCodeFixBackend
│   ├── openCodeFixBackend.ts       # Prompt + backend entrypoint
│   ├── opencodeTransport.ts        # Transport adapter layer
│   ├── opencodeServerManager.ts    # Local opencode serve lifecycle
│   ├── opencodeSdkClient.ts        # Official OpenCode SDK wrapper
│   ├── opencodeTurnRunner.ts       # Single-turn orchestration
│   ├── opencodeSession.ts          # Session lifecycle and finalize safety
│   └── opencodeEventAdapter.ts     # Event normalization helpers
├── skills/
│   ├── memcheck-skills.md          # Repair heuristics
│   ├── msagent-patterns.md         # Repo conventions
│   └── skillLoader.ts              # Prompt assembly
├── vscode/
│   ├── diagnosticsManager.ts       # Problems panel publishing
│   ├── codeActionProvider.ts       # Quick Fix actions
│   └── fixService.ts               # Queue, orchestration, webview updates
└── webview/
    ├── messages.ts                 # Webview message protocol
    ├── sessionState.ts             # Fix Details reducer/state
    ├── fixDetailsScript.ts         # Webview client script
    └── webviewPanelProvider.ts     # Panel lifecycle
```

## OpenCode Protocol — Read First

Before editing ANY of:

- `src/backends/opencodeTransport.ts`
- `src/backends/opencodeSession.ts`
- `src/backends/opencodeEventAdapter.ts`
- `src/backends/openCodeFixBackend.ts`
- `test/fixtures/llm-scenarios/*.json`

You MUST first read `.claude/skills/opencode-protocol/SKILL.md` (or invoke
the `opencode-protocol` skill). It contains the wire-truth contract anchored
to evidence captured locally against opencode 1.14.25:

- real SSE format `{type, properties}` (NOT the `{type, part}` / `{type, tool_call}`
  shapes that fixtures use after adapter normalization)
- terminal predicate: `message.updated` with `info.role==="assistant"` and
  `info.time.completed` set — NOT `session.idle`, NOT `server.heartbeat`,
  NOT a code-block in text
- 32-event SDK union plus the undocumented `server.heartbeat`
- 19+ HTTP endpoints (the `/doc` OpenAPI declares only 2)

State which Hard Rule (R1–R6) and which trap your change touches before
writing code. Add a fixture in `test/fixtures/llm-scenarios/` BEFORE
implementation when changing finalize logic.

## Important Behavioral Notes

- `DiagnosticsManager` attaches a stable `msAgentIndex` to each diagnostic.
- `codeActionProvider.ts` routes Quick Fix directly through `msagent.fixProblem(index)`.
- `OpenCodeSession` must not finalize success on soft-close signals such as `session.idle` or `server.disconnect`. See `opencode-protocol` skill, R2.
- `OpenCodeFixBackend` disposes transport only after `session.run()` settles. See `opencode-protocol` skill, R3.
- Successful fixes must end with a three-part explanation: `Problem:` / `Fix:` / `Why it works:`.
- If OpenCode does not persist a compliant explanation, `OpenCodeSession` must synthesize one from the diagnostic and applied diff instead of surfacing `Explanation unavailable` as a success result.

## Test Layout

- `src/**/*.test.ts` for unit tests
- `test/fixtures/*.log` for log fixtures
- `test/fixtures-src/*.cpp` for source fixtures
- `test/fixtures/llm-scenarios/*.json` for OpenCode event/session scenarios

## graphify

This project maintains a graphify knowledge graph at `graphify-out/`.

Rules:

- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md`
- If `graphify-out/wiki/index.md` exists, prefer that over raw file traversal
- After modifying code in the session, run `graphify update .`
