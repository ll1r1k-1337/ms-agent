# OpenCode Backend Setup Guide

This guide explains how to configure and use the **OpenCode backend** for msAgent, which delegates memory error fixing to the OpenCode CLI/agent instead of the built-in OpenAI-compatible LLM provider.

---

## Overview

By default, msAgent uses the `builtin` backend: it connects directly to your configured LLM (Ollama, vLLM, etc.) and runs an internal agent loop with `read_file` and `edit_file` tools.

The **OpenCode backend** (`msagent.provider = "opencode"`) shifts this responsibility to OpenCode. This is useful if:

- You already use OpenCode as your primary AI coding assistant
- You want to leverage OpenCode's built-in tool ecosystem and prompts
- You prefer a single agent runtime rather than maintaining separate LLM configurations

---

## Prerequisites

1. **VSCode** >= 1.85
2. **msAgent extension** installed and compiled
3. **OpenCode CLI** installed and available in your `$PATH`

```bash
# Verify OpenCode is installed
opencode --version

# If not installed, follow the OpenCode documentation to install it
```

---

## Configuration

Open VSCode settings (JSON) and add the following entries:

```json
{
  "msagent.provider": "opencode",
  "msagent.opencodeMode": "cli",
  "msagent.opencodeCliPath": "opencode",
  "msagent.opencodeServePort": 7325,
  "msagent.opencodeApiEndpoint": "http://localhost:7325",
  "msagent.opencodeApiKey": "",
  "msagent.timeoutMs": 300000
}
```

### Settings Reference

| Setting | Default | Description |
|---|---|---|
| `msagent.provider` | `openai-compatible` | Backend provider. Set to `opencode` to enable this backend. |
| `msagent.opencodeMode` | `cli` | Transport mode: `cli` or `server`. (`api` is reserved for future use.) |
| `msagent.opencodeCliPath` | `opencode` | Path to the OpenCode executable. Use an absolute path if it is not in your `$PATH`. |
| `msagent.opencodeServePort` | `7325` | Port for `server` mode. |
| `msagent.opencodeApiEndpoint` | `http://localhost:7325` | URL for the OpenCode server when in `server` mode. |
| `msagent.opencodeApiKey` | `""` | API key for authenticated OpenCode server endpoints. |
| `msagent.timeoutMs` | `300000` | Maximum time to wait for a fix (milliseconds). Default is 5 minutes. |

---

## Architecture

The OpenCode backend is structured in four layers:

### 1. FixBackend Interface

All repair backends implement the same contract:

```typescript
interface FixBackend {
    readonly name: string;
    executeFix(diagnostic, context, callbacks): Promise<FixResult>;
    supportsStreaming(): boolean;
    cancel(): void;
}
```

`OpenCodeFixBackend` implements this interface. It builds a fix prompt from the diagnostic, spawns the transport, and delegates the rest to `OpenCodeSession`.

### 2. Transport Layer

`createTransport(config)` returns the appropriate transport:

| Mode | Class | Status |
|---|---|---|
| `cli` | `CliTransport` | **Implemented and functional** |
| `server` | `ServeTransport` | Stub — throws "not yet implemented" |
| `api` | `ApiTransport` | Stub — throws "not yet implemented" |

- **CLI transport** spawns `opencode run --format json` as a child process, pipes the prompt into `stdin`, and parses NDJSON events from `stdout`.
- **Server/API transports** will eventually connect to a long-running OpenCode HTTP/WebSocket server.

### 3. Session Layer

`OpenCodeSession` manages the lifecycle of a single fix operation:

- Starts the transport with the compiled prompt
- Listens for events (text, tool calls, errors, completion)
- Runs a tool loop: when OpenCode requests a tool, the session executes it via `executeTool()` and sends the result back
- Applies a hard timeout (`timeoutMs`) and an inactivity timeout (120s)
- On completion, extracts the fixed code block, compares it with the original, and writes the file if changed

### 4. Event Adapter

`opencodeEventAdapter.ts` normalizes the various JSON event shapes that OpenCode emits into a unified internal representation:

- `extractTextDelta(event)` — streaming text fragments
- `extractToolCall(event)` — tool invocations with name and parameters
- `extractToolResult(event)` — tool execution results
- `extractErrorMessage(event)` — error payloads
- `isCompletionEvent(event)` — end-of-stream signals

This makes the session resilient to minor format changes in OpenCode output.

---

## Recommended Setup

**For production use**, switch to `server` mode once it becomes available:

```json
{
  "msagent.provider": "opencode",
  "msagent.opencodeMode": "server",
  "msagent.opencodeApiEndpoint": "http://localhost:7325"
}
```

Server mode will offer:
- Faster connection reuse (no process spawn overhead)
- True bidirectional streaming
- Better visibility into intermediate reasoning steps

**For now**, use `cli` mode as a compatibility/degraded fallback. It works out of the box but carries the limitations described below.

---

## CLI Mode (Degraded / Compatibility Mode)

When `msagent.opencodeMode` is set to `cli`, msAgent runs OpenCode as a one-shot subprocess:

```bash
opencode run --format json
```

### How it works

1. msAgent builds a prompt containing the error description and the complete source file
2. The prompt is written to the subprocess `stdin`
3. OpenCode processes the request internally and streams NDJSON events to `stdout`
4. msAgent parses the final code block and applies it to the file

### Limitations

- **One-shot execution**: The entire interaction happens inside a single subprocess invocation. There is no persistent session between fixes.
- **Tool calls handled internally**: Any tool use by OpenCode is opaque to msAgent. You will not see `read_file` or `edit_file` steps in the WebView as you do with the `builtin` backend.
- **Limited visibility**: Intermediate reasoning steps are not surfaced in the UI. You only see the final output or an error.
- **Slower startup**: Spawning a new process for each fix adds overhead compared to a long-running server.
- **Degraded indicator**: When CLI mode is active, the UI marks the session as degraded and shows a warning banner reminding you that `server` mode is recommended for the best experience.

---

## Troubleshooting

### "OpenCode CLI not found"

**Symptom**: Fix fails immediately with `OpenCode CLI not found at: opencode`.

**Solution**:
- Verify `opencode` is installed: `opencode --version`
- If it is installed in a non-standard location, set the full path in VSCode settings:
  ```json
  {
    "msagent.opencodeCliPath": "/usr/local/bin/opencode"
  }
  ```

### Timeout issues

**Symptom**: Fix fails with `OpenCode reached hard timeout after 300s` or `OpenCode stalled: no events for 120s`.

**Solution**:
- Increase the global timeout:
  ```json
  {
    "msagent.timeoutMs": 600000
  }
  ```
- Use a smaller/faster model if your current one is too slow for the file size.
- Check that OpenCode is not hanging on a large file or an infinite loop.

### No changes made

**Symptom**: The fix completes but the file is unchanged, or you see `OpenCode returned the same code. No changes were made.`

**Solution**:
- OpenCode may not have returned a valid markdown code block. Check the WebView output for the raw response.
- Ensure the source file is not read-only.
- Try increasing `maxTokens` if the response was truncated before the closing code block.
- If OpenCode returned no code block at all, verify that your OpenCode installation supports the `--format json` flag and is not outputting plain text.
