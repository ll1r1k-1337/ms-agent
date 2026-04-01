# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-01

### Added

- **Streaming Webview for LLM Output**: Real-time display of LLM responses during code fixes
  - Opens automatically when a fix is triggered
  - Streams LLM text output with live cursor animation
  - Shows tool calls with parameters in formatted blocks
  - Displays tool results and errors
  - Renders code diffs using diff2html (side-by-side view)
  - Syntax highlighting via highlight.js
  - Read-only interface (no user input allowed)

- **Streaming LLM Provider**: Added `streamChat()` async generator method to `OpenAICompatProvider`
  - Parses SSE (Server-Sent Events) format from OpenAI-compatible endpoints
  - Supports text delta streaming
  - Handles tool call argument streaming with buffering
  - Works with Ollama and other OpenAI-compatible backends

- **Agent Loop Streaming Callbacks**: Extended `runAgent()` with streaming support
  - `onMessageChunk`: Receives streaming text chunks
  - `onToolCall`: Notifies when a tool is called (includes toolCallId)
  - `onToolResult`: Reports tool execution results
  - `onDiff`: Emits code diff when `edit_file` is called
  - Auto-detects streaming support and falls back gracefully

### Changed

- **Webview Architecture**: Created modular webview system
  - `src/webview/messages.ts`: Message type definitions
  - `src/webview/webviewPanelProvider.ts`: Panel lifecycle and messaging
  - `src/llm/types.ts`: Streaming types (StreamChunk, StreamingLLMProvider)

### Technical Details

- Uses AsyncGenerator pattern for streaming (native JavaScript)
- diff2html + highlight.js for diff rendering (CDN loaded)
- No additional npm dependencies required
- Webview uses VSCode theme variables for styling

---

## [0.1.0] - 2026-04-01

### Added

- **Progress Display Enhancement**: Replaced status bar progress with `vscode.window.withProgress` API for prominent progress notifications
  - Shows current operation (e.g., `read_file(path)` or `edit_file(oldText, newText)`)
  - Displays batch fix progress (e.g., `Fixing OUT_OF_BOUNDS (1/3)`)
  - Progress notifications are now cancellable via built-in cancel button

- **Cancellation Support**: Added `CancellationTokenSource` for user-cancellable LLM operations
  - Connected `abortSignal` to Agent loop for graceful cancellation
  - User can click "Cancel" button in progress notification to stop ongoing fixes

- **Configuration Validation**: Added startup validation for LLM endpoint
  - Pings LLM endpoint with 30-second timeout on extension activation
  - Shows user-friendly dialog if LLM is not reachable
  - Provides "Configure", "Skip", and "Don't Ask Again" options
  - "Don't Ask Again" preference persisted in `globalState`

- **New Commands**:
  - `msagent.clearDiagnostics` — Clear all msAgent diagnostics from Problems panel
  - `msagent.openSettings` — Open msAgent settings page directly

- **Keyboard Shortcuts**:
  - `Cmd+Alt+L` / `Ctrl+Alt+L` — Parse log file
  - `Cmd+Alt+F` / `Ctrl+Alt+F` — Fix all issues
  - `Cmd+Alt+C` / `Ctrl+Alt+C` — Clear diagnostics

- **Configurable Timeout**: Added `msagent.timeoutMs` setting (default: 300000ms = 5 minutes)
  - Allows users to adjust timeout for complex fixes or larger models
  - Range: 30000ms to 600000ms (30s to 10 minutes)

### Changed

- **Enhanced Diagnostic Metadata**:
  - Added `code` field to diagnostics (set to error type)
  - Added `relatedInformation` showing call stack frames
  - Enhanced diagnostic message to include byte size and address space details

- **Resource Management**: Created singleton `getOutputChannel()` function to reuse OutputChannel and prevent resource leaks from repeated `createOutputChannel` calls

- **Timeout Improvements**:
  - Increased default timeout from 120000ms (2 min) to 300000ms (5 min)
  - Increased validation ping timeout from 5000ms to 30000ms to match test configuration
  - Exposed timeout as configurable VSCode setting

- **Error Messages**: Improved timeout error message to suggest actual timeout setting instead of maxTokens

### Fixed

- **Path Resolution Bug**: Fixed "View Changes" failing with relative file paths from logs
  - Added `resolveFilePath()` helper to convert relative filenames to absolute paths
  - Searches in workspace root and log directory for file resolution
  - Fixed call stack frame path resolution in relatedInformation
  - Prevents "cannot open file:///add_custom.cpp" errors

- Removed unnecessary comments from `extension.ts` for cleaner code
- Improved error messages in fix service with more specific context
- Fixed configuration mismatch between T2 test (30s timeout) and extension validation (5s timeout)

### Technical Details

- Progress notifications use `ProgressLocation.Notification` for visibility
- All LLM operations wrapped in cancellable async contexts
- TypeScript strict mode compliance verified
- No new dependencies added
- Path resolution uses workspace root and last log directory as search paths

### Breaking Changes

None. All changes are backward compatible.

---

## Future Roadmap

### Planned for v0.2.0

- Status bar item showing diagnostic count
- Welcome/activation message for first-time users
- Configuration wizard for LLM endpoint setup
- TreeView for browsing diagnostics by error type
- Multi-file fix support across workspace