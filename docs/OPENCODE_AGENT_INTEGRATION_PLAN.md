# msAgent OpenCode Integration Plan

This document now describes the architecture that actually exists in the repository after the OpenCode-only refactor.

## Scope

msAgent no longer supports:

- a built-in OpenAI-compatible backend
- host-side custom agent tools
- OpenCode `cli` or `api` transports
- a dedicated settings webview

The extension now routes all fixes through OpenCode using `server` or `acp`.

## Architecture

```text
fixService
  -> backendFactory
  -> OpenCodeFixBackend
  -> OpenCodeTransport (server | acp)
  -> OpenCodeSession
  -> WebView event stream
```

### Layer responsibilities

| Layer | File | Responsibility |
|---|---|---|
| Factory | `src/backends/backendFactory.ts` | Always returns `OpenCodeFixBackend` |
| Backend | `src/backends/openCodeFixBackend.ts` | Builds the prompt, resolves config, starts transport and session |
| Transport | `src/backends/opencodeTransport.ts` | Handles `server` or `acp` process / connection lifecycle |
| Session | `src/backends/opencodeSession.ts` | Consumes transport events, protects finalization, computes diffs |
| Adapter | `src/backends/opencodeEventAdapter.ts` | Normalizes heterogeneous OpenCode events |

## Transport modes

### `server`

- Reuses a running `opencode serve` process when available
- Spawns one when needed
- Treats `session.idle` and `server.disconnect` as soft signals
- Cancels by sending abort first, then waiting through a grace period before disconnecting

### `acp`

- Spawns `opencode acp`
- Uses stdio JSON-RPC
- Performs initialize, session creation, prompt, and cancel over ACP
- Normalizes `session/update` notifications into the same event stream used by the webview

## Event model

The Fix Details panel consumes a unified stream of events, including:

- `backend_info`
- `status`
- `text_stream`
- `tool_call`
- `tool_result`
- `diff`
- `final_diff`
- `queue_state`
- `error`

The UI does not need to branch on transport mode.

## Quick Fix routing

The current single-problem fix path is:

```text
diagnostic
  -> msAgentIndex
  -> CodeActionProvider
  -> msagent.fixProblem(index)
  -> fixService.fixProblem(index)
```

This replaced the older line-based fuzzy matching approach.

## Safety guarantees

Current session logic is intentionally conservative:

- transport disposal happens only after `session.run()` settles
- soft-close events do not count as success
- cancellation sends a protocol-level abort before closing connections
- unfinished sessions do not overwrite files

## References Used During Refactor

- `formulahendry/vscode-acp` for ACP client structure and VS Code-facing message patterns
- `saffron-health/opencode-gui` for OpenCode service lifecycle ideas
- `kodu-ai/claude-coder` for session state and queue-oriented streaming structure

These repositories informed the shape of the implementation, but the final code in this repo is adapted to msAgent’s existing extension and webview structure.
