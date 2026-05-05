# msAgent

**English** | [中文](./README.md)

**msAgent** is a VS Code extension that parses `mssanitizer --tool=memcheck` logs and uses **OpenCode** to repair memory issues in Ascend C / C++ operator code.

## What It Does

- Parses msSanitizer logs into VS Code diagnostics
- Exposes Quick Fix actions for individual problems
- Runs fixes through OpenCode server only
- Reuses or auto-starts local `opencode serve`, then talks to it through the official `@opencode-ai/sdk`
- Uses a trimmed Fix Details panel: status, current action, result, and changed files stay on the first screen; raw details are folded into `Technical details`
- Distinguishes no-op outcomes: `NO_FIX_NEEDED` becomes a neutral "No Change" result, while `CANNOT_FIX` shows the OpenCode reason directly

## Supported Error Types

- `ILLEGAL_ADDR_READ`
- `ILLEGAL_ADDR_WRITE`
- `OUT_OF_BOUNDS`
- `MISALIGNED_ACCESS`
- `MEM_LEAK`
- `ILLEGAL_FREE`
- `MEM_UNUSED`
- `UNINITIALIZED_READ`

## Setup

```bash
git clone <repo-url> ms-agent
cd ms-agent
npm install
npm run compile
```

Open the project in VS Code and press `F5`.

## Requirements

- VS Code `>= 1.85`
- Node.js `>= 18`
- `opencode` installed locally

## Configuration

All settings are exposed through native VS Code settings under `msagent`.

| Setting | Default | Description |
|---|---|---|
| `msagent.modelName` | `opencode/big-pickle` | Full OpenCode model ID used for repairs |
| `msagent.timeoutMs` | `300000` | Per-fix timeout |
| `msagent.opencodeServePort` | `7325` | Port for `opencode serve` |
| `msagent.opencodeCliPath` | `opencode` | OpenCode executable path |
| `msagent.opencodeApiKey` | `""` | Optional API key forwarded to OpenCode |

## Commands

| Command | Description |
|---|---|
| `msAgent: Parse Log File` | Parse a log file and publish diagnostics |
| `msAgent: Fix All Issues` | Fix all msAgent diagnostics for the active file |
| `msAgent: Clear Diagnostics` | Clear all msAgent diagnostics |

`msagent.fixProblem` remains as the internal single-problem entrypoint used by Quick Fix and tests.

## Current Architecture

```text
log file
  -> parser/logParser.ts
  -> vscode/diagnosticsManager.ts
  -> vscode/codeActionProvider.ts
  -> vscode/fixService.ts
  -> backends/openCodeFixBackend.ts
  -> backends/opencodeTransport.ts
  -> backends/opencodeServerManager.ts
  -> backends/opencodeSdkClient.ts
  -> backends/opencodeTurnRunner.ts
  -> backends/opencodeSession.ts
  -> webview/webviewPanelProvider.ts
```

Key runtime roles:

- `opencodeServerManager.ts`: detects, reuses, and starts local `opencode serve`
- `opencodeSdkClient.ts`: wraps the official OpenCode SDK for session / event / abort / messages
- `opencodeTurnRunner.ts`: enforces the repair turn order: subscribe first, create session, send prompt, then wait for a hard terminal event

This codebase no longer includes:

- host-side custom tool execution
- a built-in OpenAI-compatible backend
- a dedicated settings webview
- OpenCode `cli`, `api`, or `acp` transport modes

## Test Commands

```bash
npm run compile
npm test
npm run test:integration
npm run test:coverage
```

- `npm test`: repo-local unit and fixture coverage, no real `opencode` required
- `npm run test:integration`: real local OpenCode validation, requires `MSAGENT_LOCAL_MODEL`
- `npm run test:coverage`: coverage run excluding the real local OpenCode suite

## Docs

- [docs/SOURCE_GUIDE.md](./docs/SOURCE_GUIDE.md)
- [docs/TEST_GUIDE.md](./docs/TEST_GUIDE.md)

## License

MIT
