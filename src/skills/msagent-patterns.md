---
name: msagent-patterns
description: Coding patterns extracted from the current OpenCode-only msAgent repository
version: 2.0.0
source: local-git-analysis
---

# msAgent Patterns

## Current Architecture

```text
src/
├── extension.ts
├── parser/                  # mssanitizer log parsing
├── llm/                     # OpenCode-only config + stream types
├── backends/                # OpenCode backend, transport, session, adapters
├── skills/                  # Repair knowledge + prompt helpers
├── vscode/                  # Diagnostics, quick fix, orchestration
└── webview/                 # Fix Details panel
```

## Important Constraints

- All automated fixes run through OpenCode
- Transport mode is only `server`
- VS Code settings are the only configuration UI
- Quick Fix targets diagnostics by `msAgentIndex`, not fuzzy line matching
- External integrations should use `msagent.fixIssue(payload)` when they own diagnosis and Problems publication

## Design Patterns

### 1. OpenCode-only backend selection

`backendFactory.ts` always returns `OpenCodeFixBackend`. New fix features should plug into the OpenCode flow, not add parallel backends.

### 2. Transport / session split

- `opencodeTransport.ts` owns process / network / JSON-RPC lifecycle
- `opencodeSession.ts` owns event interpretation, finalize rules, and diff calculation
- `opencodeEventAdapter.ts` stays pure and testable

### 3. Diagnostic identity by index

`diagnosticsManager.ts` attaches `msAgentIndex` to each published diagnostic. `codeActionProvider.ts` uses that index to route directly into `fixProblem(index)`.

### 3b. Direct payload repair

`repairIssue.ts` validates and normalizes caller-owned issue payloads. `fixService.fixIssue()` queues the normalized `RepairIssue` directly without storing it in `DiagnosticsManager` or publishing msAgent Problems.

### 4. Conservative finalization

Soft-close signals such as `session.idle` or connection end are not treated as success. The session only finalizes after a hard terminal condition, cancellation settlement, or timeout handling.

## Configuration Keys

- `msagent.modelName`
- `msagent.timeoutMs`
- `msagent.opencodeServePort`
- `msagent.opencodeCliPath`

## Testing Patterns

- Co-located `*.test.ts` files under `src/`
- Fixture logs in `test/fixtures/`
- Source fixtures in `test/fixtures-src/`
- Scenario fixtures in `test/fixtures/llm-scenarios/`
- VS Code APIs mocked in `test/vscode-mock.ts`

## Change Guidance

When extending the repo:

1. Prefer adapting the existing OpenCode event stream over adding a new side channel.
2. Keep WebView payloads transport-agnostic.
3. Add tests for lifecycle edges, especially cancel and soft-close behavior.
4. Preserve exact source text outside the intended edit region.
