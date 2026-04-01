# msAgent Extension Specification

## 1. Overview

### 1.1 Purpose

msAgent is a VSCode extension that automatically fixes Ascend NPU operator memory errors detected by mssanitizer. It uses local LLMs (Ollama/vLLM) to analyze errors, generate fixes, and apply them via an agent loop with tool calling.

### 1.2 Key Features

- Parse mssanitizer `--tool=memcheck` logs and push diagnostics to VSCode Problems panel
- Agent-based intelligent fix: `Read file → Analyze error → Generate fix → Apply edit → Verify loop`
- Support for all 8 memory error types (OUT_OF_BOUNDS, ILLEGAL_ADDR_*, MISALIGNED_ACCESS, etc.)
- CodeAction quick fix support (lightbulb icon / `Cmd+.`)
- Real-time LLM output streaming in WebView
- Tool call visualization with parameters and results
- Side-by-side diff view showing before/after file changes
- Fully local execution (no cloud API dependency)
- Compatible with any OpenAI `/v1/chat/completions` endpoint

### 1.3 Supported Error Types

| Error Type | Description |
|------------|-------------|
| `OUT_OF_BOUNDS` | Buffer overflow/underflow |
| `ILLEGAL_ADDR_READ` | Read from invalid memory address |
| `ILLEGAL_ADDR_WRITE` | Write to invalid memory address |
| `MISALIGNED_ACCESS` | Unaligned memory access |
| `MEM_LEAK` | Memory not freed |
| `ILLEGAL_FREE` | Invalid free operation |
| `MEM_UNUSED` | Allocated but never used |
| `UNINITIALIZED_READ` | Read from uninitialized memory |

---

## 2. System Architecture

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         VSCode Extension                     │
│                                                               │
│  ┌──────────────┐      ┌──────────────┐      ┌───────────┐ │
│  │   Commands   │─────▶│   Parser     │─────▶│  Diagnos- │ │
│  │  (parseLog)  │      │ (logParser)  │      │  ticsMgr  │ │
│  └──────────────┘      └──────────────┘      └───────────┘ │
│                                                       │      │
│  ┌──────────────┐      ┌──────────────┐             │      │
│  │  CodeAction  │─────▶│  FixService  │◀────────────┘      │
│  │   Provider   │      │              │                     │
│  └──────────────┘      └──────┬───────┘                     │
│                               │                              │
│                               ▼                              │
│                    ┌─────────────────────┐                  │
│                    │     Agent Loop      │                  │
│                    │  (runAgent Loop)    │                  │
│                    └──────────┬──────────┘                  │
│                               │                              │
│         ┌─────────────────────┼─────────────────────┐       │
│         ▼                     ▼                     ▼       │
│  ┌────────────┐      ┌──────────────┐      ┌────────────┐  │
│  │    LLM     │      │    Tools     │      │  WebView   │  │
│  │  Provider  │      │  (read/edit) │      │  Provider  │  │
│  └────────────┘      └──────────────┘      └────────────┘  │
│         │                                          │        │
└─────────┼──────────────────────────────────────────┼────────┘
          │                                          │
          ▼                                          ▼
    ┌───────────┐                           ┌──────────────┐
    │   Ollama  │                           │  User View   │
    │   /v1/    │                           │  (Streaming) │
    └───────────┘                           └──────────────┘
```

### 2.2 Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **Commands** | Register and handle VSCode commands (parseLog, fixAll, etc.) |
| **Parser** | Parse mssanitizer log format into structured diagnostics |
| **DiagnosticsManager** | Manage diagnostic lifecycle, resolve file paths, publish to VSCode |
| **CodeActionProvider** | Provide quick fix actions for diagnostics |
| **FixService** | Orchestrate fix workflow, handle progress, error messages |
| **Agent Loop** | Execute tool-calling loop with LLM, manage conversation history |
| **LLM Provider** | Handle HTTP communication with Ollama/OpenAI-compatible endpoints |
| **Tools** | Implement file operations (read_file, edit_file, list_files, etc.) |
| **WebView Provider** | Display real-time LLM output, tool calls, and diffs |

---

## 3. Data Flow

### 3.1 Fix Workflow

```
User Action: Click "Fix: OUT_OF_BOUNDS"
          │
          ▼
┌─────────────────────────────────┐
│ 1. FixService.fixDiagnostic()   │
│    - Save original file content │
│    - Create WebView panel       │
│    - Send task info to WebView  │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 2. runAgent() Loop              │
│    - Build prompt from skill    │
│    - Call LLM with tools        │
│    - Stream response to WebView │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 3. Tool Execution (per tool)    │
│    - Show tool call in WebView  │
│    - Execute tool (read/edit)   │
│    - Show result in WebView     │
│    - Add to message history     │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 4. Completion                   │
│    - Read final file content    │
│    - Generate side-by-side diff │
│    - Send final_diff to WebView │
│    - Mark message_complete      │
└─────────────────────────────────┘
```

### 3.2 Message Types

| Message Type | Direction | Payload | Purpose |
|--------------|-----------|---------|---------|
| `text_stream` | Extension → WebView | `{messageId, delta}` | Stream LLM text output |
| `tool_call` | Extension → WebView | `{messageId, toolCallId, name, params}` | Show tool invocation |
| `tool_result` | Extension → WebView | `{toolCallId, result, isError}` | Show tool execution result |
| `diff` | Extension → WebView | `{path, oldText, newText, toolCallId}` | Show individual edit diff |
| `final_diff` | Extension → WebView | `{path, oldContent, newContent, message}` | Show complete file diff |
| `message_complete` | Extension → WebView | `{messageId}` | Signal completion, hide stop button |
| `error` | Extension → WebView | `{message}` | Display error message |
| `clear` | Extension → WebView | `{}` | Clear WebView content |
| `stop` | WebView → Extension | `{}` | User clicked stop button |

---

## 4. Key Components

### 4.1 LLM Provider

**File**: `src/llm/openaiCompatProvider.ts`

**Purpose**: Communicate with Ollama/OpenAI-compatible LLM endpoints

**Key Methods**:

```typescript
class OpenAICompatProvider implements LLMProvider {
    // Non-streaming request
    async chat(
        messages: Message[],
        tools: ToolDefinition[],
        systemPrompt?: string
    ): Promise<LLMResponse>;
    
    // Streaming request (AsyncGenerator pattern)
    async *streamChat(
        messages: Message[],
        tools: ToolDefinition[],
        systemPrompt?: string
    ): AsyncGenerator<StreamChunk>;
}
```

**Ollama-Specific Handling**:

| Feature | OpenAI | Ollama | Handling |
|---------|--------|--------|----------|
| Reasoning | N/A | `delta.reasoning` | Yield as text_delta |
| Tool calls | Incremental | Complete object | Parse immediately |
| Arguments | String | String or Object | Try JSON.parse, fallback to raw |
| ID field | Required | Optional | Generate if missing |

**Timeout Management**:
- Default: 300000ms (5 minutes)
- Validation: 30000ms (30 seconds)
- Configurable via `msagent.timeoutMs`

---

### 4.2 Agent Loop

**File**: `src/agent/agentLoop.ts`

**Purpose**: Execute tool-calling loop with conversation history management

**Parameters**:

```typescript
interface AgentRunOptions {
    systemPrompt: string;
    taskDescription: string;
    toolContext: ToolContext;
    llm: LLMProvider;
    maxToolRounds?: number;          // Default: 10
    useStreaming?: boolean;          // Default: true
    abortSignal?: { aborted: boolean };
    onMessageChunk?: (chunk, messageId) => void;
    onToolCall?: (name, params, toolCallId) => void;
    onToolResult?: (toolCallId, result, isError) => void;
    onDiff?: (path, oldText, newText, toolCallId) => void;
    onTextResponse?: (text: string) => void;
}
```

**Loop Protection**:

1. **Max Rounds**: Stop after N tool call rounds (default: 10)
2. **Consecutive Failures**: Stop after 3 consecutive tool errors
3. **Abort Signal**: Check cancellation at multiple points:
   - Loop start
   - After LLM response
   - Before tool execution
4. **Message Trimming**: Limit conversation to 100 messages (trim non-system)

**AbortSignal Pattern**:

```typescript
// ✅ CORRECT: Real-time check via getter
abortSignal: { 
    get aborted() { 
        return token.isCancellationRequested; 
    } 
}

// ❌ WRONG: Snapshot (won't update)
abortSignal: { aborted: token.isCancellationRequested }
```

---

### 4.3 Tools

**File**: `src/tools/toolHandlers.ts`

**Available Tools**:

| Tool | Description | Parameters |
|------|-------------|------------|
| `read_file` | Read file contents | `path`, `startLine?`, `endLine?` |
| `edit_file` | Apply search-and-replace edit | `path`, `oldText`, `newText` |
| `list_files` | List workspace files | `directory?`, `pattern?` |
| `read_diagnostics` | Get current diagnostics | None |

**edit_file Matching Strategy**:

1. **Exact match**: Search for `oldText` exactly as provided
2. **Normalized match**: If exact fails, normalize whitespace and try again
3. **Line search**: Find the approximate line and extract actual text
4. **Error message**: Include file snippet and searched text for debugging

**Path Resolution**:

```typescript
function resolveFilePath(fileName: string, workspaceRoot: string): string {
    // 1. Check if absolute and exists
    // 2. Search in workspace root
    // 3. Search in last log directory
    // 4. Fallback to workspace root
}
```

---

### 4.4 WebView Provider

**File**: `src/webview/webviewPanelProvider.ts`

**Purpose**: Display real-time LLM output, tool calls, and diffs

**Content Security Policy**:

```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'none'; 
               style-src ${webview.cspSource} 'unsafe-inline'; 
               script-src 'nonce-${nonce}';">
```

**Key Constraints**:

- ❌ **NO external CDN links** (blocked by CSP)
- ✅ Inline styles with `'unsafe-inline'`
- ✅ Inline scripts with `nonce` mechanism
- ✅ Use `webview.cspSource` for local resources

**Message Handlers**:

```javascript
// WebView JavaScript
window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.type) {
        case 'text_stream':    appendText(...);    break;
        case 'tool_call':      appendToolCall(...); break;
        case 'tool_result':    appendToolResult(...); break;
        case 'diff':           appendDiff(...);     break;
        case 'final_diff':     appendFinalDiff(...); break;
        case 'message_complete': completeMessage(...); break;
        case 'error':          showError(...);      break;
        case 'clear':          clear();             break;
    }
});
```

**Diff Rendering**:

- **Tool-level diff** (`diff` message): Simple `-`/`+` line format
- **Final diff** (`final_diff` message): Side-by-side table with:
  - Left column: Original file (red background, strikethrough for deletions)
  - Right column: Modified file (green background for additions)
  - Show only changed lines ± 2 context lines

---

### 4.5 Diagnostics Manager

**File**: `src/vscode/diagnosticsManager.ts`

**Purpose**: Manage diagnostic lifecycle and file path resolution

**Key Methods**:

```typescript
class DiagnosticsManager {
    static parseFileAndPublish(filePath: string): ParseResult;
    static parseAndPublish(logContent: string): ParseResult;
    static getCurrentDiagnostics(): SanitizerDiagnostic[];
    static getLastLogDir(): string | undefined;
    static clearDiagnostics(): void;
    static resolveFileUri(fileName: string, searchDirs: string[]): vscode.Uri | undefined;
}
```

**Path Resolution During Parsing**:

When parsing logs, update diagnostic filenames from relative to absolute:

```typescript
// In parseFileAndPublish()
const searchDirs = [workspaceRoot, lastLogDir];
for (const d of currentDiagnostics) {
    const resolvedUri = DiagnosticsManager.resolveFileUri(d.fileName, searchDirs);
    if (resolvedUri) {
        d.fileName = resolvedUri.fsPath;  // Update to absolute path
    }
}
```

This ensures "View Changes" works correctly without re-resolving paths.

---

## 5. Configuration

### 5.1 VSCode Settings

**File**: `package.json`

```json
{
  "contributes": {
    "configuration": {
      "title": "msAgent",
      "properties": {
        "msagent.modelEndpoint": {
          "type": "string",
          "default": "http://localhost:11434",
          "description": "LLM API endpoint URL (OpenAI-compatible, e.g. Ollama, vLLM)"
        },
        "msagent.modelName": {
          "type": "string",
          "default": "qwen3:8b",
          "description": "Local model name"
        },
        "msagent.temperature": {
          "type": "number",
          "default": 0.1,
          "minimum": 0,
          "maximum": 2,
          "description": "LLM temperature for fix generation"
        },
        "msagent.maxTokens": {
          "type": "number",
          "default": 4096,
          "minimum": 256,
          "maximum": 32768,
          "description": "Max tokens for LLM response"
        },
        "msagent.timeoutMs": {
          "type": "number",
          "default": 300000,
          "minimum": 30000,
          "maximum": 600000,
          "description": "LLM request timeout in milliseconds (default: 5 minutes for complex fixes)"
        }
      }
    }
  }
}
```

### 5.2 Configuration Access

```typescript
import { getLLMConfig } from './llm/config';

const config = getLLMConfig();
// config.endpoint: string
// config.modelName: string
// config.temperature: number
// config.maxTokens: number
// config.timeoutMs: number
```

---

## 6. Commands

### 6.1 Registered Commands

| Command | Title | Keybinding | Description |
|---------|-------|------------|-------------|
| `msagent.parseLog` | msAgent: Parse Log File | `Cmd+Alt+L` / `Ctrl+Alt+L` | Parse mssanitizer log file |
| `msagent.fixAll` | msAgent: Fix All Issues | `Cmd+Alt+F` / `Ctrl+Alt+F` | Fix all diagnostics in current file |
| `msagent.clearDiagnostics` | msAgent: Clear Diagnostics | `Cmd+Alt+C` / `Ctrl+Alt+C` | Clear all msAgent diagnostics |
| `msagent.openSettings` | msAgent: Open Settings | - | Open msAgent settings |
| `msagent.testWebview` | msAgent: Test WebView | - | Test WebView communication |

### 6.2 Activation Events

```json
{
  "activationEvents": [
    "onLanguage:cpp",           // Activate when opening C++ files
    "onCommand:msagent.parseLog",
    "onCommand:msagent.fixAll",
    "onCommand:msagent.testWebview"
  ]
}
```

---

## 7. Skill System

### 7.1 Skill Loading

**File**: `src/skills/skillLoader.ts`

```typescript
export function loadSkill(errorType: string): Skill {
    // Map error type to skill file
    const skillFile = `src/skills/${errorType.toLowerCase()}-skill.md`;
    // Load and parse skill
    // Return skill with systemPrompt and examples
}

export function buildFixPrompt(diagnostic: SanitizerDiagnostic): string {
    const skill = loadSkill(diagnostic.errorType);
    // Build prompt with:
    // 1. Error type and location
    // 2. Error details (byte size, address space)
    // 3. Call stack
    // 4. Skill-specific guidance
    // 5. Available tools
}
```

### 7.2 Skill File Format

**File**: `src/skills/memcheck-skills.md`

```markdown
# ms-agent Memory Error Fix Patterns

## Ascend C Kernel Memory Architecture
- GM, UB, L1 memory spaces
- Key APIs: DataCopy, pipe.InitBuffer, etc.
- Memory size rules

## Fix Strategies by Error Type

### OUT_OF_BOUNDS
- Cause: Buffer overflow
- Fix: Ensure DataCopy size matches buffer capacity

### ILLEGAL_ADDR_READ/WRITE
- Cause: Invalid memory access
- Fix: Check bounds before access

[... etc ...]
```

---

## 8. Error Handling

### 8.1 Error Categories

| Category | Code | Description | User Action |
|----------|------|-------------|-------------|
| **Connection** | `CONNECTION_REFUSED` | LLM server not running | Start Ollama: `ollama serve` |
| **Timeout** | `TIMEOUT` | LLM request timed out | Increase timeout or use smaller model |
| **HTTP** | `HTTP_ERROR` | HTTP error from LLM | Check endpoint URL |
| **Tool** | `TOOL_ERROR` | Tool execution failed | Check tool parameters |
| **Parse** | `PARSE_ERROR` | Failed to parse LLM response | Check model output |

### 8.2 User-Friendly Error Messages

```typescript
function handleFixError(error: unknown, config: LLMConfig): void {
    let friendly = 'msAgent fix failed';
    
    if (error instanceof LLMProviderError) {
        switch (error.code) {
            case 'CONNECTION_REFUSED':
                friendly += 'Cannot connect to LLM.\n\n';
                friendly += 'Suggestions:\n';
                friendly += '• Start Ollama: ollama serve\n';
                friendly += '• Check endpoint: ' + config.endpoint;
                break;
            case 'TIMEOUT':
                friendly += 'LLM request timed out.\n\n';
                friendly += 'Suggestions:\n';
                friendly += '• Use a smaller model (qwen3:8b instead of 30b)\n';
                friendly += '• Increase timeoutMs setting (current: ' + config.timeoutMs + 'ms)\n';
                friendly += '• Simplify the fix by fixing one error at a time';
                break;
            // ... other cases
        }
    }
    
    vscode.window.showErrorMessage(friendly);
}
```

---

## 9. Performance Considerations

### 9.1 Message History Management

**Problem**: Unbounded message history causes context overflow.

**Solution**: Trim to 100 messages, preserving system messages:

```typescript
if (messages.length > 100) {
    const toRemove = messages.length - 100;
    for (let i = 0; i < toRemove && i < messages.length; i++) {
        if (messages[i].role !== 'system') {
            messages.splice(i, 1);
            i--;
        }
    }
}
```

### 9.2 WebView Rendering

**Problem**: Too many DOM nodes cause lag.

**Solutions**:
- ✅ Limit tool result display to 500 characters
- ✅ Use `textContent` instead of `innerHTML` when possible
- ✅ Auto-scroll only on new content
- ❌ Avoid highlighting large code blocks (CSP blocks highlight.js)

### 9.3 LLM Streaming

**Problem**: Long responses without feedback feel slow.

**Solutions**:
- ✅ Always stream responses (better UX)
- ✅ Show real-time progress in WebView
- ✅ Display tool calls as they happen
- ✅ Cancellable via CancellationToken

---

## 10. Testing

### 10.1 Manual Testing Checklist

**Extension Activation**:
- [ ] Open C++ file → extension activates
- [ ] Output → msAgent channel appears
- [ ] Run `msAgent: Test WebView` → WebView opens and shows test message

**Log Parsing**:
- [ ] Parse log file → diagnostics appear in Problems panel
- [ ] Click diagnostic → file opens at correct line
- [ ] Diagnostic shows call stack in relatedInformation

**Fix Workflow**:
- [ ] Click lightbulb → "Fix: ERROR_TYPE" appears
- [ ] Click fix → WebView opens
- [ ] LLM thinking (reasoning) streams to WebView
- [ ] Tool calls displayed with parameters
- [ ] Tool results displayed (green/red)
- [ ] Side-by-side diff shown at completion
- [ ] File actually modified

**Cancellation**:
- [ ] Click Stop button → operation stops immediately
- [ ] Progress notification shows cancel button
- [ ] Clicking cancel stops operation

**Error Handling**:
- [ ] LLM not running → user-friendly error message
- [ ] Timeout → suggestions to increase timeout or use smaller model
- [ ] Tool error → shown in WebView with error styling

### 10.2 Test Log Files

**Location**: `test/fixtures/`

**Available Logs**:
- `out_of_bounds.log` - OUT_OF_BOUNDS error at line 30
- `illegal_addr_read.log` - ILLEGAL_ADDR_READ error
- `illegal_addr_write.log` - ILLEGAL_ADDR_WRITE error

**Source Files**:
- `test/fixtures-src/add_custom.cpp` - C++ file with intentional bugs

---

## 11. Known Limitations

### 11.1 Current Limitations

1. **No syntax highlighting** - CSP blocks external highlight.js CDN
   - **Workaround**: Could download highlight.js locally
   
2. **No advanced diff rendering** - CSP blocks diff2html CDN
   - **Workaround**: Could download diff2html locally

3. **Single-file fixes only** - Cannot fix across multiple files
   - **Future**: Add workspace-wide fix support

4. **No persistent conversation** - Each fix starts fresh
   - **Future**: Add multi-turn conversation support

5. **Tool call streaming unreliable with Ollama** - Tool calls arrive as complete objects
   - **Current**: Handle as complete objects, not incremental

### 11.2 Performance Limits

| Metric | Limit | Reason |
|--------|-------|--------|
| Max tool rounds | 10 | Prevent infinite loops |
| Max consecutive failures | 3 | Stop if tool repeatedly fails |
| Max message history | 100 | Prevent context overflow |
| Max tool result display | 500 chars | WebView performance |
| Default timeout | 5 minutes | Balance UX and reliability |

---

## 12. Future Enhancements

### 12.1 Planned Features

1. **Syntax highlighting** - Download highlight.js locally and use `webview.asWebviewUri()`
2. **Advanced diff rendering** - Download diff2html locally
3. **TreeView** - Sidebar panel showing all diagnostics
4. **Configuration wizard** - Guided setup for LLM endpoint
5. **Multi-file fixes** - Fix errors across workspace
6. **Persistent conversation** - Remember context between fixes
7. **Custom tool definitions** - Allow users to define custom tools
8. **Telemetry** - Anonymous usage analytics (opt-in)

### 12.2 Architecture Improvements

1. **Event-based architecture** - Decouple components with event emitter
2. **State machine** - Model fix workflow as state machine
3. **Plugin system** - Allow third-party tool plugins
4. **Mock LLM** - For testing without real LLM

---

## 13. Troubleshooting Guide

### 13.1 WebView Blank

**Symptoms**: WebView opens but shows nothing, no right-click menu

**Check**:
1. Open WebView DevTools: `Cmd+Shift+P` → "Developer: Open Webview Developer Tools"
2. Check Console for errors
3. Verify CSP headers don't block resources

**Common Causes**:
- External CDN links (blocked by CSP)
- JavaScript errors
- Missing `nonce` attribute on script tags

**Solution**: Remove all external CDN links, use inline or local resources

### 13.2 Extension Not Activating

**Symptoms**: No Output channel, commands don't appear

**Check**:
1. `Cmd+Shift+P` → "Developer: Show Running Extensions"
2. Look for "msAgent" in the list
3. Check "Log (Extension Host)" for errors

**Common Causes**:
- `activationEvents` too restrictive
- TypeScript compilation error
- Missing dependency

**Solution**: Add appropriate `activationEvents`, fix compilation errors

### 13.3 LLM Not Responding

**Symptoms**: Timeout errors, no streaming output

**Check**:
1. `curl http://localhost:11434/api/tags` - Is Ollama running?
2. `ollama list` - Is model installed?
3. Check `msagent.modelEndpoint` setting

**Common Causes**:
- Ollama not running (`ollama serve`)
- Wrong model name
- Incorrect endpoint URL
- Timeout too short

**Solution**: Start Ollama, verify model name, increase timeout

### 13.4 Tool Calls Failing

**Symptoms**: Tool shows error, no file changes

**Check**:
1. WebView shows tool parameters
2. File path is absolute
3. oldText matches exactly in file

**Common Causes**:
- Relative path not resolved
- oldText has different whitespace
- File doesn't exist

**Solution**: 
- Check file path in tool call
- Copy exact text from file for oldText
- Use read_file first to verify content

---

## 14. API Reference

### 14.1 Public API

```typescript
// Diagnostics
DiagnosticsManager.parseFileAndPublish(filePath: string): ParseResult;
DiagnosticsManager.clearDiagnostics(): void;
DiagnosticsManager.getCurrentDiagnostics(): SanitizerDiagnostic[];

// Fix Service
fixDiagnostic(uri: string, lineNumber: number): Promise<void>;
fixAllDiagnostics(uri: string): Promise<void>;

// LLM
getLLMConfig(): LLMConfig;
OpenAICompatProvider.chat(messages, tools, systemPrompt): Promise<LLMResponse>;
OpenAICompatProvider.streamChat(messages, tools, systemPrompt): AsyncGenerator<StreamChunk>;

// Agent
runAgent(options: AgentRunOptions): Promise<AgentResult>;

// WebView
WebviewPanelProvider.createOrShow(context: ExtensionContext): vscode.WebviewPanel;
WebviewPanelProvider.postMessage(message: WebviewMessage): void;
WebviewPanelProvider.clear(): void;
```

### 14.2 Type Definitions

```typescript
// From src/parser/types.ts
interface SanitizerDiagnostic {
    fileName: string;
    lineNumber: number;
    errorType: string;
    severity: Severity;
    byteSize?: number;
    addressSpace?: string;
    callStack?: StackFrame[];
}

// From src/llm/config.ts
interface LLMConfig {
    endpoint: string;
    modelName: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
}

// From src/llm/types.ts
interface StreamChunk {
    type: 'text_delta' | 'tool_use_start' | 'tool_use_delta' | 'done' | 'error';
    delta?: string;
    toolCall?: {
        id: string;
        name?: string;
        input?: Record<string, unknown>;
        inputDelta?: string;
    };
    error?: string;
}

// From src/agent/agentLoop.ts
interface AgentResult {
    finalMessage: string;
    toolCallCount: number;
    messages: Message[];
}
```

---

## 15. Dependencies

### 15.1 Runtime Dependencies

```json
{
  "dependencies": {
    // None - uses native Node.js modules only
  },
  "devDependencies": {
    "@types/node": "^18.x",
    "@types/vscode": "^1.85.0",
    "typescript": "^5.x"
  }
}
```

### 15.2 Peer Dependencies

- **VSCode**: >= 1.85.0
- **Ollama** (or compatible LLM server): Running locally

---

## 16. Version History

### v0.2.0 (2026-04-01)

**Added**:
- Streaming WebView for LLM output
- Tool call visualization
- Side-by-side diff view
- Stop button for cancellation
- Configurable timeout settings

**Fixed**:
- WebView blank issue (CSP)
- Agent infinite loop
- Ollama tool call parsing
- Path resolution for logs

### v0.1.0 (2026-04-01)

**Initial Release**:
- Parse mssanitizer logs
- Push diagnostics to VSCode
- CodeAction quick fixes
- Agent loop with tool calling
- Support for 8 memory error types

---

## 17. License

[Specify license here]

---

## 18. Contributors

[List contributors here]

---

**End of Specification**