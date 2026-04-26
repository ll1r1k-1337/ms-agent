# Implementation Plan: OpenCode TUI WebView

## Requirements Restatement

Transform the msAgent VSCode extension webview from a static "Initializing fix session..." loading screen into a real-time, streaming TUI-like interface that mirrors the OpenCode terminal experience. The webview must display:

- User prompts and messages
- Assistant responses streaming in real-time
- Thinking/reasoning content
- Tool calls with parameters
- Tool results
- File diffs
- Status updates and progress

## Current State Analysis

### Architecture
- `ServeTransport` connects to OpenCode server via SSE (`/event`) and HTTP API
- `OpenCodeSession` processes events through callbacks (`onMessageChunk`, `onToolCall`, `onToolResult`, `onDiff`, `onEvent`)
- `fixService.ts` forwards callbacks to `WebviewPanelProvider.postMessage()`
- `fixDetailsScript.ts` renders messages in the webview

### Critical Issues Identified

1. **Event Pipeline Broken**: `ServeTransport.runViaHttpApi()` exits immediately when `prompt_async` returns non-null (line 706-708), leaving the SSE stream orphaned. The session waits for `onClose` which never fires naturally.

2. **Event Format Uncertainty**: `extractTextDelta` checks many paths but may miss the actual OpenCode SSE event format. No empirical validation exists.

3. **WebView Message Gap**: The webview only shows the waiting indicator, suggesting either no messages arrive or they're not in the expected format.

## Implementation Phases

### Phase 1: Fix Event Pipeline (CRITICAL - Blocking)

**Goal**: Ensure OpenCode server events reliably reach the webview.

**Tasks**:
1. Fix `ServeTransport.runViaHttpApi()` flow:
   - Remove premature return after `prompt_async` success
   - Ensure transport waits for SSE stream completion or explicit close
   - Add proper completion detection from SSE events

2. Enhance event extraction in `opencodeEventAdapter.ts`:
   - Add logging for raw event shapes to understand actual format
   - Handle `event.parts[]` array format (OpenCode message parts)
   - Handle nested `properties.content`, `properties.delta` paths
   - Add fallback for unknown event structures

3. Add comprehensive debug logging:
   - Log every raw SSE line received
   - Log parsed event type and keys
   - Log extraction results (textDelta found/not found)
   - Log all callback invocations

**Files to modify**:
- `src/backends/opencodeTransport.ts`
- `src/backends/opencodeEventAdapter.ts`
- `src/backends/opencodeSession.ts`

**Estimated time**: 2-3 hours

### Phase 2: WebView Message Architecture

**Goal**: Redesign webview to display streaming chat content like OpenCode TUI.

**Tasks**:
1. Add new message types to `messages.ts`:
   - `thinking_stream` - For reasoning/thinking content
   - `code_block` - For code output
   - `progress_update` - For status/progress messages
   - `command_output` - For shell command output

2. Restructure `fixDetailsScript.ts`:
   - Replace session-state-based UI with message-thread UI
   - Implement chat bubble layout (user right, assistant left)
   - Add streaming cursor animation for active messages
   - Show thinking blocks with distinct styling
   - Render tool calls as expandable cards
   - Render tool results inline below tool calls
   - Keep diff rendering for file changes

3. Update message handler to maintain a message thread:
   - Track message sequence (user -> assistant -> tool -> result)
   - Group related content under message IDs
   - Auto-scroll to latest content

**Files to modify**:
- `src/webview/messages.ts`
- `src/webview/fixDetailsScript.ts`
- `src/webview/webviewPanelProvider.ts`

**Estimated time**: 4-5 hours

### Phase 3: Real-Time Streaming Display

**Goal**: Make the webview feel like a live TUI with smooth streaming.

**Tasks**:
1. Implement virtual scrolling or efficient DOM updates for long conversations
2. Add syntax highlighting for code blocks
3. Add collapsible sections for:
   - Long tool outputs
   - Multiple reasoning steps
   - File diff summaries
4. Add a status bar showing:
   - Connection state
   - Current phase
   - Tool call count
   - Token/character count
5. Add keyboard shortcuts (via webview message passing):
   - Escape to cancel
   - Ctrl+C copy

**Files to modify**:
- `src/webview/fixDetailsScript.ts`
- `src/webview/webviewPanelProvider.ts`

**Estimated time**: 3-4 hours

### Phase 4: Bidirectional Communication

**Goal**: Allow user interaction through the webview.

**Tasks**:
1. Add input field at bottom of webview:
   - Text input for follow-up messages
   - Send button
   - Support for multi-line input

2. Extend message protocol:
   - `user_input` message from webview to extension
   - Handle user input in `fixService.ts`
   - Forward to OpenCode session

3. Add action buttons:
   - Retry button for failed fixes
   - Accept/Reject buttons for diffs
   - Clear conversation button

**Files to modify**:
- `src/webview/fixDetailsScript.ts`
- `src/webview/messages.ts`
- `src/webview/webviewPanelProvider.ts`
- `src/vscode/fixService.ts`

**Estimated time**: 3-4 hours

### Phase 5: Testing & Polish

**Goal**: Verify end-to-end functionality and fix edge cases.

**Tasks**:
1. Test all transport modes:
   - Server mode (`opencode serve` + SSE)
   - API mode (direct HTTP API)

2. Add unit tests for:
   - Event extraction with various formats
   - Session state transitions
   - Webview message rendering

3. Handle edge cases:
   - Connection drops mid-stream
   - Very long responses
   - Unicode/special characters
   - Multiple concurrent sessions

4. Performance:
   - Profile DOM update frequency
   - Implement throttling if needed
   - Optimize message buffering

**Files to modify**:
- `src/backends/opencodeEventAdapter.test.ts`
- `src/backends/opencodeSession.test.ts`
- `src/webview/fixDetailsScript.test.ts`
- `src/webview/webviewPanelProvider.test.ts`

**Estimated time**: 3-4 hours

## Dependencies

- OpenCode server must be running (for server mode testing)
- OpenCode CLI must be installed (for CLI mode testing)
- Existing HTTP/SSE infrastructure (Node.js built-ins)

## Risks

| Risk | Level | Mitigation |
|------|-------|------------|
| OpenCode server event format is undocumented | HIGH | Add extensive logging and format detection; be defensive |
| SSE connection reliability | MEDIUM | Implement reconnection logic; add health checks |
| WebView performance with long conversations | MEDIUM | Implement virtual scrolling; batch DOM updates |
| VSCode webview CSP restrictions | LOW | Use inline styles; avoid external resources |
| Backward compatibility with existing fix flow | MEDIUM | Keep existing queue/timeline UI as fallback |

## Estimated Complexity: HIGH

- Phase 1: 2-3 hours
- Phase 2: 4-5 hours
- Phase 3: 3-4 hours
- Phase 4: 3-4 hours
- Phase 5: 3-4 hours
- **Total: 15-20 hours**

## Success Criteria

- [ ] WebView shows user prompt immediately after fix starts
- [ ] Assistant response streams in real-time character by character
- [ ] Thinking/reasoning content appears with distinct styling
- [ ] Tool calls show name and parameters
- [ ] Tool results appear below corresponding tool calls
- [ ] File diffs render with syntax highlighting
- [ ] Status updates show current phase
- [ ] No "Initializing fix session..." spinner remains after first message
- [ ] Works with CLI, server, and API transport modes

## Immediate Next Steps (if approved)

1. Start Phase 1: Add raw event logging to understand actual OpenCode SSE format
2. Fix `ServeTransport` premature return bug
3. Test with a real OpenCode server to verify events flow
4. Then proceed to Phase 2 webview redesign

**WAITING FOR CONFIRMATION**: Proceed with this plan? (yes/no/modify)
