# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

msAgent is a VS Code extension that parses `mssanitizer --tool=memcheck` logs and repairs Ascend C / C++ memory issues through **OpenCode**.

The repository is now **OpenCode-only**:

- no built-in OpenAI-compatible backend
- no host-side custom tool executor
- no settings webview
- no OpenCode `cli` or `api` transport mode

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
- `msagent.opencodeMode` — `server` or `acp`
- `msagent.opencodeServePort`
- `msagent.opencodeCliPath`
- `msagent.opencodeAcpArgs`
- `msagent.opencodeApiKey`

## Source Code Architecture

```text
src/
├── extension.ts
├── parser/
├── llm/
├── backends/
├── skills/
├── vscode/
└── webview/
```

Key modules:

- `src/backends/openCodeFixBackend.ts`
- `src/backends/opencodeTransport.ts`
- `src/backends/opencodeSession.ts`
- `src/vscode/diagnosticsManager.ts`
- `src/vscode/codeActionProvider.ts`
- `src/vscode/fixService.ts`

## OpenCode Protocol — Read First

Before editing any file under `src/backends/opencode*` or
`test/fixtures/llm-scenarios/`, you MUST invoke the `opencode-protocol`
skill or read `.claude/skills/opencode-protocol/SKILL.md`. It is the
wire-truth contract for opencode 1.14.25, captured locally:

- SSE wire envelope is `{type, properties}` flat — NOT the
  `{type, part}` / `{type, tool_call}` shapes used by adapter-normalized
  test fixtures
- terminal predicate is `message.updated` with `info.role==="assistant"`
  and `info.time.completed` set — `session.idle`, `server.heartbeat`,
  `server.disconnect` and partial code-blocks are NOT terminal
- 32-event SDK union plus undocumented `server.heartbeat`
- 19+ real HTTP endpoints; OpenAPI `/doc` only declares 2 — do not trust it

Cite the relevant Hard Rule (R1–R6) and known trap before writing code.

## Important Behavioral Notes

- Diagnostics carry `msAgentIndex` metadata and Quick Fix routes by that index
- Transport modes are only `server` and `acp`
- Soft-close events must not be treated as successful completion (see `opencode-protocol` skill, R2)
- Transport disposal happens only after `session.run()` settles (see `opencode-protocol` skill, R3)

## Test Layout

- `src/**/*.test.ts`
- `test/fixtures/*.log`
- `test/fixtures-src/*.cpp`
- `test/fixtures/llm-scenarios/*.json`

## graphify

This project maintains a graphify knowledge graph at `graphify-out/`.

Rules:

- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md`
- If `graphify-out/wiki/index.md` exists, prefer that over raw file traversal
- After modifying code in the session, run `graphify update .`
