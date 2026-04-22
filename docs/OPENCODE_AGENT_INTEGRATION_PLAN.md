# msAgent OpenCode Agent Integration Plan

**Version:** PR-D (Trae Solo-style Agent Timeline)  
**Scope:** Backend architecture, event protocol, WebView lifecycle, and degradation strategy for the msAgent VSCode extension.

---

## 1. Architecture Goals

The OpenCode integration introduces a multi-backend agent system while preserving the existing built-in agent loop. The design prioritizes four goals:

| Goal | Rationale |
|---|---|
| **Backend-agnostic UI** | The WebView renders agent activity identically whether the backend is `BuiltInFixBackend` (OpenAI-compatible) or `OpenCodeFixBackend` (OpenCode CLI/serve/API). No UI code branches on backend type. |
| **Event-driven real-time updates** | All backend activity flows through a unified `onEvent` callback (`FixCallbacks.onEvent`), emitted as typed payloads. The WebView receives these as WebView messages and renders them incrementally. |
| **Graceful degradation** | CLI mode (subprocess spawn) is fully implemented. Serve mode (HTTP/WebSocket) and API mode (REST) exist as transport stubs with clear fallback semantics. The UI shows a degradation banner when running in limited modes. |
| **Incremental evolution** | PR-A through PR-D each added layers without rewriting prior work. The `FixBackend` interface from PR-A remains the contract; PR-B added transport/session; PR-C expanded events; PR-D upgraded rendering. |

---

## 2. Backend Layering

### 2.1 Layer Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         fixService.ts                           │
│              (orchestrates queue, wires callbacks)              │
└─────────────────────────────┬───────────────────────────────────┘
                              │ FixCallbacks.onEvent / onToolCall / ...
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     FixBackend (interface)                      │
│  executeFix(diagnostic, context, callbacks?) => Promise<FixResult> │
│  supportsStreaming(): boolean                                   │
│  cancel(): void                                                 │
└──────────────┬────────────────────────────────┬─────────────────┘
               │                                │
               ▼                                ▼
┌──────────────────────────┐      ┌──────────────────────────────┐
│   BuiltInFixBackend      │      │     OpenCodeFixBackend       │
│  (src/backends/          │      │    (src/backends/            │
│   builtInFixBackend.ts)  │      │     openCodeFixBackend.ts)   │
│                          │      │                              │
│  Wraps runAgent() from   │      │  Creates transport + session │
│  agent/agentLoop.ts      │      │  (~75 lines)                 │
│  + OpenAICompatProvider  │      │                              │
└──────────────┬───────────┘      └──────────────┬───────────────┘
               │                                 │
               ▼                                 ▼
┌──────────────────────────┐      ┌──────────────────────────────┐
│   OpenAICompatProvider   │      │   createTransport()          │
│  (src/llm/               │      │  (src/backends/              │
│   openaiCompatProvider.ts)│     │   opencodeTransport.ts)      │
│                          │      │                              │
│  HTTP /v1/chat/completions│     │  Mode: cli | serve | api     │
│  Streaming JSON chunks   │      │                              │
└──────────────────────────┘      └──────────────┬───────────────┘
                                                  │
                              ┌───────────────────┼───────────────┐
                              ▼                   ▼               ▼
                        ┌──────────┐      ┌──────────┐      ┌──────────┐
                        │CliTransport│    │ServeTransport│   │ApiTransport│
                        │(complete) │     │  (stub)    │     │  (stub)   │
                        └────┬─────┘     └──────────┘      └──────────┘
                             │
                             ▼
                   ┌─────────────────┐
                   │  OpenCodeSession │
                   │(src/backends/   │
                   │ opencodeSession.ts)│
                   │                 │
                   │  Tool loop +    │
                   │  event emission │
                   └────────┬────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │opencodeEventAdapter│
                   │(src/backends/   │
                   │ opencodeEventAdapter.ts)│
                   │                 │
                   │  Pure SSE event │
                   │  parsing (no IO)│
                   └─────────────────┘
```

### 2.2 Layer Responsibilities

| Layer | File | Responsibility |
|---|---|---|
| **Factory** | `src/backends/backendFactory.ts` | Selects concrete backend based on `config.provider`. Exports unified types. |
| **Interface** | `src/backends/fixBackend.ts` | Defines `FixBackend`, `FixCallbacks`, `FixContext`, `FixResult`. The `onEvent` callback (added in PR-C) is the extensibility hook. |
| **Built-in Backend** | `src/backends/builtInFixBackend.ts` | Instantiates `OpenAICompatProvider`, invokes `runAgent()` from `src/agent/agentLoop.ts`, and forwards streaming callbacks. Uses `AbortController` for cancellation. |
| **OpenCode Backend** | `src/backends/openCodeFixBackend.ts` | Resolves file paths, builds the OpenCode prompt, constructs `OpenCodeTransportConfig`, calls `createTransport()`, and instantiates `OpenCodeSession`. Disposes transport in `finally`. |
| **Transport** | `src/backends/opencodeTransport.ts` | Abstracts I/O mode. `CliTransport` spawns `opencode run --format json`, manages stdio, timers (hard timeout + inactivity timeout), and process lifecycle. `ServeTransport` and `ApiTransport` are stubs. |
| **Session** | `src/backends/opencodeSession.ts` | Runs the agent tool loop: receives events from transport, parses text deltas, extracts tool calls via `opencodeEventAdapter`, executes tools via `executeTool()`, sends results back via `transport.send()`, and emits lifecycle events. |
| **Event Adapter** | `src/backends/opencodeEventAdapter.ts` | Pure, side-effect-free parsing. Handles multiple OpenCode event formats (`tool_call`, `tool_use`, `part` wrappers). Exposes `extractToolCall`, `extractToolResult`, `extractTextDelta`, `extractErrorMessage`, `isCompletionEvent`. |

### 2.3 Built-in Backend Flow

`BuiltInFixBackend.executeFix()` performs the following:

1. Creates `OpenAICompatProvider` with settings from `getLLMConfig()`.
2. Loads the `memcheck-skills` skill and appends it to the fix prompt.
3. Calls `runAgent()` with `maxToolRounds: 10`, streaming enabled.
4. Forwards `onMessageChunk`, `onToolCall`, `onToolResult`, and `onDiff` to the caller's `FixCallbacks`.
5. After `runAgent()` resolves, re-reads the file from disk to detect changes.
6. Returns `FixResult` with `fileChanged`, `originalContent`, and `newContent`.

Cancellation: `BuiltInFixBackend.cancel()` calls `AbortController.abort()`, which `runAgent()` checks via the `abortSignal` getter.

### 2.4 OpenCode Backend Flow

`OpenCodeFixBackend.executeFix()` performs the following:

1. Resolves the target file path and reads `originalContent`.
2. Builds a prompt via `buildOpenCodePrompt()` that instructs the model to return the complete fixed file inside a markdown code block.
3. Creates an `OpenCodeTransportConfig` with mode derived from `config.opencodeMode` (default `'cli'`).
4. Calls `createTransport(config)` to get a concrete `OpenCodeTransport`.
5. Instantiates `OpenCodeSession(transport, callbacks)`.
6. Calls `session.run({ prompt, workspaceRoot, resolvedPath, originalContent, timeoutMs })`.
7. In a `finally` block, calls `transport.dispose()`.

The session runs a Promise-based loop:

- Registers `transport.onEvent`, `onClose`, `onError`.
- On each event, calls `opencodeEventAdapter` extractors.
- Text deltas flow to `callbacks.onMessageChunk`.
- Tool calls increment `toolCallCount`, emit `onToolCall` and `step_update`, then `executeTool()` is invoked. The result is sent back to the transport via `transport.send({ type: 'tool_result', ... })`.
- On `isCompletionEvent()` or transport close/error, `finalize()` computes the result by extracting the code block from accumulated text, comparing it to `originalContent`, writing if changed, and emitting `session_end`.

---

## 3. Event Protocol

All real-time communication flows through `FixCallbacks.onEvent(type, payload)`, forwarded by `fixService.ts` into WebView messages. The same types are used by both backends.

### 3.1 Event Type Reference

| Type | Payload Shape | When Emitted | Backend |
|---|---|---|---|
| `session_start` | `{ backend: string; mode?: string }` | First event when a fix begins. | OpenCode (always). Built-in emits equivalent via `backend_info`. |
| `backend_info` | `{ backend: string; mode: string; degraded?: boolean }` | Once at start, after the panel is ready but before execution. | Both. Emitted by `fixService.ts` at line 618. |
| `status` | `{ phase: string; message?: string }` | Phase transitions: `running` (after transport start), `finalizing` (on completion event). | OpenCode. Built-in does not emit granular phases. |
| `step_update` | `{ step: string; detail?: string }` | On tool call (`step: 'tool_call'`) and tool result (`step: 'tool_result'`). | OpenCode. Built-in emits tool_call/tool_result through dedicated callbacks, not `onEvent`. |
| `text_stream` | `{ messageId: string; delta: string }` | For every text delta from the LLM. | Both. In OpenCode, via `extractTextDelta`. In built-in, via `onMessageChunk`. |
| `tool_call` | `{ messageId: string; toolCallId: string; name: string; params: Record<string, unknown> }` | When the LLM requests a tool. | Both. |
| `tool_result` | `{ toolCallId: string; result: string; isError: boolean }` | After tool execution completes. | Both. |
| `diff` | `{ path: string; oldText: string; newText: string; toolCallId: string }` | When a tool mutates a file (intermediate diff). | Both. Built-in emits via `onDiff`. OpenCode emits during finalize if code block differs. |
| `final_diff` | `{ path: string; oldContent: string; newContent: string; message: string }` | Once at the end if the fix succeeded and the file changed. | `fixService.ts` synthesizes this from `FixResult` after `executeFix()` resolves. |
| `error` | `{ message: string }` | On transport failure, timeout, parse failure, or when the fix produces no changes. | Both / `fixService.ts`. |
| `session_end` | `{ success: boolean; finalMessage: string }` | Final event when the session closes, regardless of outcome. | OpenCode (always). `fixService.ts` infers equivalent for built-in. |
| `queue_state` | `{ paused: boolean; hasPendingTasks: boolean; items: QueueStateItem[] }` | Whenever the fix queue changes (enqueue, start, complete, pause, cancel). | `fixService.ts` (queue manager). |
| `message_complete` | `{ messageId: string }` | After `final_diff` or `error` has been sent. | `fixService.ts`. |

### 3.2 Lifecycle Sequence

```
fixService.ts calls backend.executeFix()
            │
            ▼
    ┌───────────────┐
    │  backend_info │  ← "backend": "opencode", "mode": "cli"
    └───────────────┘
            │
            ▼
    ┌───────────────┐
    │  session_start│  ← OpenCode only
    └───────────────┘
            │
            ▼
    ┌───────────────┐
    │     status    │  ← phase: "running", message: "Waiting..."
    └───────────────┘
            │
            ▼
    ┌─────────────────────────────┐
    │  Streaming loop (repeated)  │
    │  text_stream → tool_call →  │
    │  step_update → tool_result →│
    │  step_update                │
    └─────────────────────────────┘
            │
            ▼
    ┌───────────────┐
    │     status    │  ← phase: "finalizing"
    └───────────────┘
            │
            ▼
    ┌───────────────┐
    │  final_diff   │  ← if success + fileChanged
    │     or        │
    │     error     │  ← if failed / no changes
    └───────────────┘
            │
            ▼
    ┌───────────────┐
    │ session_end   │  ← success: true/false
    └───────────────┘
            │
            ▼
    ┌───────────────┐
    │message_complete│
    └───────────────┘
```

### 3.3 OpenCode Event Format Normalization

OpenCode emits events in multiple shapes depending on the transport and version. `opencodeEventAdapter.ts` normalizes these into a single representation:

- **Tool call shapes handled:**
  - `{ type: 'tool_call', tool_call: { name, arguments, id } }`
  - `{ type: 'tool_use', part: { type: 'tool', toolName, state: { input } } }`
  - `{ part: { type: 'tool_call', name, arguments, id } }`
  - Flat object: `{ toolName, args, toolCallId }`

- **Tool result shapes handled:**
  - `{ type: 'tool_result', tool_result: { toolCallId, result, isError } }`
  - `{ type: 'tool_use', part: { type: 'tool', state: { status, result } } }`
  - `{ part: { type: 'tool_result', toolCallId, result, isError } }`
  - Flat object: `{ result, toolCallId, isError }`

- **Completion triggers:** `step_end`, `message_end`, `done`, `complete`, `finish`.

This adapter is pure logic (no I/O) and can be unit tested with static JSON fixtures.

---

## 4. WebView Lifecycle

### 4.1 Panel Creation

`WebviewPanelProvider.createOrShow(context)` (`src/webview/webviewPanelProvider.ts`):

1. If a panel already exists, calls `panel.reveal(vscode.ViewColumn.Beside)`.
2. Otherwise, creates a new `vscode.WebviewPanel` with:
   - `viewType: 'msAgentFix'`
   - `title: 'msAgent Fix Details'`
   - `viewColumn: vscode.ViewColumn.Beside`
   - `enableScripts: true`
   - `retainContextWhenHidden: true`
3. Sets HTML from `getHTML()`, which embeds inline CSS and JavaScript.
4. Registers `onDidReceiveMessage` to handle:
   - `fix_details_ready`: marks `webviewReady = true`, then replays `sessionMessages` buffer and `lastQueueState`.
   - `pause_toggle`, `cancel_current`, `remove_queued`: forwards to `fixService.ts` via `onActionCallback`.

### 4.2 Message Replay

The provider maintains two buffers:

- `sessionMessages: WebviewMessage[]` (max 2000 entries). All non-`queue_state` messages are recorded via `recordSessionMessage()`.
- `lastQueueState: WebviewMessage | undefined`. The most recent queue state is always retained.

When the WebView sends `fix_details_ready`, the provider replays:

```typescript
for (const sessionMessage of this.sessionMessages) {
    this.panel?.webview.postMessage(sessionMessage);
}
if (this.lastQueueState) {
    this.panel?.webview.postMessage(this.lastQueueState);
}
```

This ensures the WebView can be closed and reopened without losing the current session's timeline.

### 4.3 Event Rendering Flow

The WebView JavaScript (inline in `webviewPanelProvider.ts`) handles incoming messages with a `switch (message.type)` dispatcher:

1. **`backend_info`** → Renders a backend badge (e.g., "OpenCode / CLI" or "Built-in"). If `degraded` is true, shows a degraded banner.
2. **`session_start`** → Initializes the timeline container, shows a phase indicator ("Analyzing...").
3. **`status`** → Updates the phase indicator text (e.g., "Waiting for OpenCode response...", "Processing fix result...").
4. **`step_update`** → Appends a timeline entry node with the step name and detail.
5. **`text_stream`** → Appends text to the current message bubble with a streaming cursor animation.
6. **`tool_call`** → Renders a tool call card showing the tool name and collapsed parameters.
7. **`tool_result`** → Updates the matching tool call card with the result (green for success, red for error).
8. **`diff`** → Renders a side-by-side diff card (added lines green, removed lines red).
9. **`final_diff`** → Renders the final diff card at the bottom of the timeline with a success border.
10. **`error`** → Renders an error card with the message.
11. **`session_end`** → Removes the streaming cursor, updates the session summary header.
12. **`clear`** → Empties the DOM and resets `sessionMessages`.

### 4.4 Clear / Reset Behavior

- **`WebviewPanelProvider.clear()`**:
  - Empties `sessionMessages`.
  - Sends `{ type: 'clear', payload: {} }` to the WebView.
  - Resets `messageIdCounter` to 0.

- **Cancellation idle cleanup** (`fixService.ts`):
  - `clearConversationOnIdleAfterCancel` flag is set when the user cancels the current fix and no further queue items exist.
  - When the queue processor finishes and detects idle state (`noRunningTask && noPausedTask && noQueuedTasks`), it calls `webviewProvider.clear()` automatically.

---

## 5. Degradation Strategy

### 5.1 Mode Matrix

| Mode | Transport | Features | Status |
|---|---|---|---|
| **CLI** | `CliTransport` spawns `opencode run --format json` | Full bidirectional I/O (stdin prompt, stdout events, stdin tool results). Subprocess lifecycle managed with SIGTERM on cancel. | **Implemented** |
| **Serve** | `ServeTransport` | Intended for HTTP/WebSocket to a long-running OpenCode server. Would support persistent sessions and richer metadata. | **Stub** — emits error on start. |
| **API** | `ApiTransport` | Intended for REST API calls to an OpenCode cloud endpoint. Would be stateless, request/response. | **Stub** — emits error on start. |

### 5.2 Degradation Indicators

When `config.provider === 'opencode'` and `config.opencodeMode` is not `'cli'`:

- `OpenCodeFixBackend.executeFix()` creates the stub transport.
- The stub immediately emits an error: `"Serve mode not yet implemented"` or `"API mode not yet implemented"`.
- `fixService.ts` catches this as a transport error and renders it in the WebView.

When running in CLI mode, the UI does **not** show a degraded banner because CLI is the fully supported OpenCode path. The degraded banner appears only when a future implementation sets `degraded: true` in the `backend_info` payload (e.g., when serve mode is available but lacks tool feedback).

### 5.3 Timeout and Stall Protection

`CliTransport` implements two safety mechanisms:

1. **Hard timeout**: `setTimeout(config.timeoutMs)`. Kills the child process with SIGTERM and emits an error.
2. **Inactivity timeout**: `setInterval(10000)`. If no event has arrived for `120000ms` (2 minutes) after receiving at least one event, the process is killed and an error is emitted.

These protect against hung model inference or deadlocked OpenCode processes.

### 5.4 Future Fallback Chain

Planned degradation order:

1. Attempt **serve** mode if configured and a health check passes.
2. Fall back to **cli** mode if serve is unreachable.
3. Fall back to **built-in** backend if OpenCode CLI is not installed.
4. Surface the fallback chain in `backend_info.degraded` and the WebView banner.

---

## 6. Backend Selection

### 6.1 Factory Logic

`createFixBackend(config: LLMConfig)` in `src/backends/backendFactory.ts`:

```typescript
export function createFixBackend(config: LLMConfig): FixBackend {
    if (config.provider === 'opencode') {
        return new OpenCodeFixBackend();
    }
    return new BuiltInFixBackend();
}
```

### 6.2 Configuration Mapping

| `config.provider` | Backend Class | Mode |
|---|---|---|
| `'openai-compatible'` (default) | `BuiltInFixBackend` | HTTP to OpenAI-compatible endpoint |
| `'opencode'` | `OpenCodeFixBackend` | `config.opencodeMode` (`cli`, `serve`, `api`) |

Relevant settings (from `src/llm/config.ts` and `src/webview/messages.ts`):

- `msagent.provider` — `'openai-compatible'` or `'opencode'`
- `msagent.opencodeMode` — `'cli'`, `'serve'`, `'api'`
- `msagent.opencodeCliPath` — path to `opencode` binary
- `msagent.opencodeServePort` — port for serve mode
- `msagent.opencodeApiEndpoint` — URL for API mode
- `msagent.opencodeApiKey` — auth key for API mode

### 6.3 Mode Validation

`OpenCodeFixBackend.executeFix()` constructs `OpenCodeTransportConfig` and passes it to `createTransport()`. The factory switches on `config.mode`:

```typescript
switch (config.mode) {
    case 'cli': return new CliTransport(config, logger);
    case 'serve': return new ServeTransport(config);
    case 'api': return new ApiTransport(config);
    default: throw new Error(`Unknown transport mode: ${config.mode}`);
}
```

CLI mode requires `config.cliPath` to be set. If undefined, `CliTransport.start()` emits an error: `"CLI path is required for CLI mode"`.

---

## 7. Session State Management

### 7.1 Pure Reducer Pattern

The WebView JavaScript maintains local state using a pure reducer. Although the current implementation is inline vanilla JS, the intended architecture is:

```typescript
type SessionState = {
    backend: string;
    mode: string;
    degraded: boolean;
    phase: 'idle' | 'running' | 'finalizing' | 'error';
    messages: TimelineEntry[];
    toolCalls: Record<string, ToolCallEntry>;
    queue: QueueStateItem[];
    paused: boolean;
};

type Action =
    | { type: 'session_start'; payload: SessionStartPayload }
    | { type: 'text_stream'; payload: TextStreamPayload }
    | { type: 'tool_call'; payload: ToolCallPayload }
    | { type: 'tool_result'; payload: ToolResultPayload }
    | { type: 'step_update'; payload: StepUpdatePayload }
    | { type: 'diff'; payload: DiffPayload }
    | { type: 'final_diff'; payload: FinalDiffPayload }
    | { type: 'error'; payload: ErrorPayload }
    | { type: 'session_end'; payload: SessionEndPayload }
    | { type: 'queue_state'; payload: QueueStatePayload }
    | { type: 'clear' };
```

The reducer returns a new `SessionState` object for every action. No mutation of the previous state.

### 7.2 Immutable Updates

Example reducer logic for `tool_result`:

```typescript
case 'tool_result': {
    return {
        ...state,
        toolCalls: {
            ...state.toolCalls,
            [action.payload.toolCallId]: {
                ...state.toolCalls[action.payload.toolCallId],
                result: action.payload.result,
                isError: action.payload.isError,
                status: 'completed',
            },
        },
    };
}
```

### 7.3 Replay Through Reducer

When the WebView reconnects and receives the `sessionMessages` replay from `WebviewPanelProvider`, it replays them by dispatching each message through the reducer in order:

```typescript
for (const message of sessionMessages) {
    state = reducer(state, message);
    render(state);
}
```

This guarantees that the visual state after replay is identical to the state before the panel was hidden.

---

## 8. Testing Strategy

### 8.1 Pure Logic Tests (No I/O)

| Target | File | Approach |
|---|---|---|
| Event adapter | `src/backends/opencodeEventAdapter.ts` | Unit tests with static JSON fixtures covering all tool call / tool result / text delta / error shapes. Assert exact return values. |
| Session reducer | WebView JS (extractable) | Property-based or table-driven: given a sequence of `WebviewMessage`, assert final `SessionState` shape. |
| OpenCode prompt builder | `src/backends/openCodeFixBackend.ts` | Mock `buildFixPrompt()` and assert the combined prompt contains required sections. |

Example test for `extractToolCall`:

```typescript
const fixtures = [
    { input: { type: 'tool_call', tool_call: { name: 'read_file', arguments: '{"path":"x.cpp"}', id: 'tc1' } }, expected: { name: 'read_file', params: { path: 'x.cpp' }, toolCallId: 'tc1' } },
    { input: { type: 'tool_use', part: { type: 'tool', toolName: 'edit_file', state: { input: { path: 'x.cpp' } } } }, expected: { name: 'edit_file', params: { path: 'x.cpp' }, toolCallId: 'unknown' } },
];

for (const f of fixtures) {
    assert.deepEqual(extractToolCall(f.input), f.expected);
}
```

### 8.2 Backend Tests (With Controlled I/O)

| Target | File | Approach |
|---|---|---|
| CLI transport | `src/backends/opencodeTransport.ts` | Spawn a mock Node.js script that emits NDJSON to stdout. Assert `onEvent` receives parsed objects. Test timeout and inactivity kill. |
| Session runner | `src/backends/opencodeSession.ts` | Inject a mock `OpenCodeTransport` that emits a scripted event sequence. Assert `FixResult` and callback invocation order. |
| Built-in backend | `src/backends/builtInFixBackend.ts` | Mock `OpenAICompatProvider` and `runAgent`. Assert cancellation aborts the controller. |

### 8.3 Integration Tests

| Target | Approach |
|---|---|
| `backendFactory` → full flow | Configure `provider: 'opencode'` with a mock CLI path. Run against a temporary file. Assert file is modified and `FixResult` is correct. |
| `fixService.ts` queue | Enqueue multiple fixes with mocked backends. Assert queue state transitions (`queued` → `running` → `fixed`) and WebView messages. |

### 8.4 What Is NOT Tested

- **DOM tests**: The WebView is inline HTML/CSS/JS inside `webviewPanelProvider.ts`. It has no external JS bundle and no test harness. Testing is done via manual QA and the reducer unit tests above.
- **Network tests**: `OpenAICompatProvider` and `ServeTransport` network layers are mocked in unit tests. E2E against real Ollama/OpenCode is manual.

---

## 9. Future Evolution

### 9.1 Transport Implementation

| Transport | Work Required | Priority |
|---|---|---|
| **Serve** | Implement HTTP POST to `/v1/run` (or OpenCode serve endpoint). Parse SSE stream. Support health check at startup. | High |
| **API** | Implement HTTP POST to `config.opencodeApiEndpoint`. Handle request/response JSON (non-streaming or SSE). | Medium |

Serve transport should reuse `opencodeEventAdapter.ts` because the SSE event shapes are identical to CLI NDJSON output.

### 9.2 Persistent Session History

Currently `sessionMessages` is an in-memory array capped at 2000 entries. Future:

- Write `sessionMessages` to `ExtensionContext.globalStorageUri` after each `session_end`.
- On VSCode restart, offer to restore the last session.
- Add a session list UI in the WebView sidebar.

### 9.3 Multi-Backend Comparison

With the `FixBackend` abstraction, it is possible to run the same diagnostic through both backends concurrently:

```typescript
const builtin = new BuiltInFixBackend();
const opencode = new OpenCodeFixBackend();

const [r1, r2] = await Promise.all([
    builtin.executeFix(diagnostic, context, callbacks1),
    opencode.executeFix(diagnostic, context, callbacks2),
]);
```

Future UI could show a split view comparing the two fixes, letting the user choose which diff to apply.

### 9.4 Tool Call Verification Layer

Introduce a `ToolVerificationLayer` between `OpenCodeSession` and `executeTool()`:

1. **Pre-check**: Validate tool arguments against schema before execution (e.g., ensure `edit_file` receives non-empty `oldText` and `newText`).
2. **Post-check**: Diff the result of `edit_file` against expected bounds (no changes outside the target function).
3. **Sandbox**: For untrusted backends, execute tools on a copy of the file and show a preview diff before writing.

This layer would be optional and enabled via `msagent.verifyToolCalls: true`.

### 9.5 Event Protocol Extensions

Planned new event types:

| Type | Payload | Use Case |
|---|---|---|
| `thinking` | `{ text: string }` | Show CoT / reasoning steps from the model. |
| `usage` | `{ promptTokens: number; completionTokens: number }` | Display token cost per fix. |
| `file_tree` | `{ files: string[] }` | Show workspace context used by the agent. |

These can be added without breaking existing WebView logic because unhandled types are silently ignored by the reducer's `default` case.

---

## Appendix A: File Index

| File | Lines | Role |
|---|---|---|
| `src/backends/backendFactory.ts` | 16 | Factory + re-exports |
| `src/backends/fixBackend.ts` | 53 | Core interfaces |
| `src/backends/builtInFixBackend.ts` | 115 | Built-in agent loop wrapper |
| `src/backends/openCodeFixBackend.ts` | 108 | OpenCode backend wrapper |
| `src/backends/opencodeTransport.ts` | 344 | Transport abstraction + CLI impl |
| `src/backends/opencodeSession.ts` | 303 | Session runner + tool loop |
| `src/backends/opencodeEventAdapter.ts` | 290 | Pure event parsing |
| `src/webview/messages.ts` | 161 | WebView message protocol |
| `src/webview/webviewPanelProvider.ts` | 635 | Panel lifecycle + HTML + JS |
| `src/vscode/fixService.ts` | 749 | Orchestration + queue |
| `src/agent/agentLoop.ts` | — | Built-in agent loop |
| `src/llm/openaiCompatProvider.ts` | — | OpenAI HTTP provider |
| `src/tools/toolHandlers.ts` | — | Tool implementations |

---

## Appendix B: Glossary

| Term | Definition |
|---|---|
| **NDJSON** | Newline-delimited JSON. The CLI transport parses stdout as one JSON object per line. |
| **SSE** | Server-Sent Events. Expected format for serve mode streaming. |
| **FixCallbacks** | Interface passed into `FixBackend.executeFix()` allowing the backend to stream progress to the UI. |
| **SessionMessages** | In-memory buffer of all WebView messages sent during the current fix session. Enables replay after panel reopen. |
| **Degraded mode** | A backend configuration with reduced capabilities (e.g., CLI mode has limited visibility compared to serve mode). |
