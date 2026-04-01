# ms-agent: Agentic Auto-Fix VSCode Extension

## Overview
A VSCode extension that parses mssanitizer log files, uses a local LLM to analyze memory errors in Ascend C / Triton operator code, and generates automated code fixes via an agentic harness.

**Status**: ✅ **v0.2.0 Released** (2026-04-01)

**Key Features Implemented**:
- ✅ LLM streaming output with real-time WebView display
- ✅ Tool call visualization (parameters + results)
- ✅ Side-by-side diff view with red/green highlighting
- ✅ Cancellable operations (Stop button + CancellationToken)
- ✅ Ollama integration with reasoning support
- ✅ All 8 memory error types supported
- ✅ CodeAction quick fixes
- ✅ Configurable timeout and LLM settings

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    VSCode Extension Layer                        │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │ Log Parser   │  │ CodeActionProv.  │  │ WebView Provider  │  │
│  │ (text→struct)│→ │ (quick fixes)    │  │ (real-time UI)    │  │
│  └──────┬───────┘  └──────┬───────────┘  └──────┬────────────┘  │
│         │                 │                     │                │
│         ▼                 ▼                     ▼                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Agent Core (Harness)                          │   │
│  │  ┌──────────┐  ┌────────────┐  ┌──────────────────────┐ │   │
│  │  │ Agent    │  │ Tool       │  │ Skills               │ │   │
│  │  │ Loop     │→│ Handlers   │  │ (error type docs)     │ │   │
│  │  │ (LLM↔tool│  │ (read/edit)│  │ (Ascend C patterns)  │ │   │
│  │  │  cycle)  │  │            │  │                      │ │   │
│  │  └──────────┘  └────────────┘  └──────────────────────┘ │   │
│  │        ↑                                                  │   │
│  │        │ abortSignal (CancellationToken)                 │   │
│  │        │ failureCounter (MAX_3)                          │   │
│  │        └──────────────────────────────────────────────────┘   │
│  └───────────────┬──────────────────────────────────────────┘   │
└──────────────────┼──────────────────────────────────────────────┘
                   │
      ┌────────────▼────────────┐
      │   LLM Provider Layer    │
      │  ┌───────┐ ┌────────┐  │
      │  │Ollama │ │ vLLM   │  │  (OpenAI-compatible API)
      │  │(stream│ │        │  │
      │  │ing)   │ │        │  │
      │  └───────┘ └────────┘  │
      └─────────────────────────┘
```

**Key Components**:

1. **WebView Provider** (`src/webview/webviewPanelProvider.ts`)
   - CSP-compliant HTML with nonce mechanism
   - Real-time message handling (text_stream, tool_call, diff, etc.)
   - Side-by-side diff rendering without external dependencies
   - Stop button for cancellation

2. **LLM Provider** (`src/llm/openaiCompatProvider.ts`)
   - Ollama-specific handling: reasoning field, complete tool calls
   - SSE streaming with AsyncGenerator pattern
   - Configurable timeout (default: 5 minutes)
   - Non-streaming fallback

3. **Agent Loop** (`src/agent/agentLoop.ts`)
   - Failure counter (MAX_CONSECUTIVE_FAILURES = 3)
   - Multi-point abort signal checking
   - Message history trimming (max 100 messages)
   - Streaming vs non-streaming mode detection

4. **Tools** (`src/tools/toolHandlers.ts`)
   - Fuzzy matching for edit_file
   - Path resolution from relative to absolute
   - Error reporting with context snippets

## Project Structure

```
ms-agent/
├── .vscode/                          # VSCode workspace config
│   └── launch.json                   # Extension debug config
├── src/
│   ├── extension.ts                  # ✅ Extension entry point
│   ├── parser/                       # ✅ Log parsing module
│   │   ├── logParser.ts              # mssanitizer text → structured diagnostics
│   │   └── types.ts                  # SanitizerDiagnostic, Severity enum
│   ├── agent/                        # ✅ Agentic harness core
│   │   ├── agentLoop.ts              # Core loop with failure protection
│   │   └── message.ts                # Message types
│   ├── llm/                          # ✅ LLM provider abstraction
│   │   ├── provider.ts               # Abstract LLMProvider interface
│   │   ├── openaiCompatProvider.ts   # OpenAI-compatible (Ollama, vLLM)
│   │   ├── config.ts                 # Model configuration
│   │   └── types.ts                  # StreamChunk, StreamingLLMProvider
│   ├── tools/                        # ✅ Agent tools
│   │   └── toolHandlers.ts           # read_file, edit_file, list_files, read_diagnostics
│   ├── skills/                       # ✅ On-demand knowledge
│   │   ├── skillLoader.ts            # Skill loading system
│   │   └── memcheck-skills.md        # Memory error patterns & fix strategies
│   ├── vscode/                       # ✅ VSCode integration
│   │   ├── diagnosticsManager.ts     # Push diagnostics, path resolution
│   │   ├── codeActionProvider.ts     # Quick Fix code actions
│   │   └── fixService.ts             # Fix orchestration, progress, WebView
│   └── webview/                      # ✅ WebView components
│       ├── webviewPanelProvider.ts   # WebView lifecycle & HTML
│       └── messages.ts               # Message type definitions
├── test/                             # ✅ Test fixtures
│   ├── fixtures/                     # Sample mssanitizer logs
│   │   ├── out_of_bounds.log
│   │   ├── illegal_addr_read.log
│   │   ├── illegal_addr_write.log
│   │   └── mixed_errors.log
│   └── fixtures-src/                 # Sample source files
│       └── add_custom.cpp            # Ascend C kernel with bugs
├── package.json                      # ✅ Extension manifest
├── tsconfig.json
├── SPEC.md                           # ✅ Technical specification
├── CHANGELOG.md                      # ✅ Version history
├── README.md                         # ✅ User documentation (Chinese)
└── README_EN.md                      # ✅ User documentation (English)
```

## Implementation Status

### ✅ Wave 1: Foundation (COMPLETE)

**T1: Project Scaffolding** — ✅ COMPLETE
- package.json with VSCode extension manifest
- tsconfig.json, eslintrc, .gitignore
- Extension entry point (activate/deactivate)
- Directory structure
- QA: `npm install` succeeds, F5 launches extension host

**T2: Log Parser + Types** — ✅ COMPLETE
- `SanitizerDiagnostic` type with all 8 memory error types
- Regex-based log parser for mssanitizer text format
- Parses: error type, severity, address, memory space, file:line, call stack
- Handles all 8 error message formats
- QA: All test fixtures parse correctly

**T3: Test Fixtures** — ✅ COMPLETE
- Sample mssanitizer logs for OUT_OF_BOUNDS, ILLEGAL_ADDR_READ/WRITE
- Sample Ascend C source (add_custom.cpp)
- QA: Fixtures are valid and diverse

### ✅ Wave 2: Agent Core (COMPLETE)

**T4: LLM Provider Abstraction** — ✅ COMPLETE
- `LLMProvider` interface: `chat()`, `streamChat()`
- `OpenAICompatProvider` with streaming support
- Tool calling support via OpenAI-compatible API
- Model configuration (endpoint, modelName, temperature, maxTokens, timeoutMs)
- **Ollama-specific handling**: reasoning field, complete tool calls
- QA: Can connect to Ollama, streaming works, tool calls parsed correctly

**T5: Agent Loop + Tool Dispatch** — ✅ COMPLETE
- Core agent loop with failure protection
- Message types: user, assistant, tool_result
- Tool dispatch registry
- Stop conditions: text response OR max rounds OR consecutive failures
- **Multi-point abort checking**
- **Message history trimming** (max 100 messages)
- QA: Agent executes tool cycles, handles multi-turn, stops on failures

**T6: Agent Tools** — ✅ COMPLETE
- `read_file`: Read source file with line range
- `edit_file`: Search-replace with fuzzy matching
- `read_diagnostics`: Return current parsed diagnostics
- `list_files`: List workspace files
- **Path resolution**: Relative → absolute
- QA: Each tool works correctly, handles errors

### ✅ Wave 3: VSCode Integration (COMPLETE)

**T7: Skills/Knowledge System** — ✅ COMPLETE
- `memcheck-skills.md`: Fix strategies for each error type
- Skill loader: inject skills based on error type
- QA: Skills loaded correctly, agent references skill content

**T8: VSCode Diagnostics + CodeActions** — ✅ COMPLETE
- `diagnosticsManager`: Parse log → push to VSCode Problems panel
- `codeActionProvider`: Quick fix actions for diagnostics
- **Path resolution during parsing** (update diagnostic.fileName to absolute)
- Progress via `withProgress` API
- QA: Diagnostics appear, CodeAction triggers fix

**T9: WebView Chat Panel** — ✅ COMPLETE
- **CSP-compliant** WebView with nonce mechanism
- Real-time LLM output streaming
- Tool call visualization (parameters + results)
- Side-by-side diff view (red/green highlighting)
- **Stop button** for cancellation
- **NO external CDN dependencies** (all inline/local)
- QA: WebView renders, shows progress, diff displays correctly

**T10: Configuration** — ✅ COMPLETE
- VSCode settings: endpoint, modelName, temperature, maxTokens, timeoutMs
- Commands: parseLog, fixAll, clearDiagnostics, openSettings, testWebview
- **Keyboard shortcuts**: Cmd+Alt+L/F/C
- QA: Settings save/load, commands appear in palette

### ✅ Wave 4: Integration + Polish (COMPLETE)

**T11: Integration Testing** — ✅ COMPLETE
- End-to-end workflow tested
- OUT_OF_BOUNDS error fix verified
- Streaming WebView display verified
- Tool calls and diff display verified
- QA: Full workflow works

**T12: Polish + Documentation** — ✅ COMPLETE
- README with usage instructions
- CHANGELOG with version history
- SPEC.md technical specification
- Error handling polish
- Streaming + cancellation support
- QA: Documentation complete

## Key Architectural Decisions

### 1. LLM Provider: OpenAI-compatible API ✅
All local model servers (Ollama, vLLM, llama.cpp, LM Studio) support the OpenAI chat completions API. We implement ONE provider that works with all of them via `POST /v1/chat/completions`.

**Implementation Notes**:
- Ollama sends tool calls as **complete objects**, not incremental deltas
- Ollama includes `reasoning` field for thinking process (qwen3 models)
- Arguments can be **string OR object** (need to handle both)
- ID field is **optional** in Ollama (generate if missing)

### 2. Agent Loop: Protected and Cancellable ✅

**Implementation**:
```typescript
while (round < maxToolRounds) {
    if (abortSignal.aborted) return;
    
    const response = await llm.chat(messages, tools);
    
    if (abortSignal.aborted) return;
    
    for (const toolCall of response.toolCalls) {
        if (abortSignal.aborted) return;
        
        const result = await executeTool(toolCall);
        
        if (result.error) {
            consecutiveFailures++;
            if (consecutiveFailures >= 3) return;
        } else {
            consecutiveFailures = 0;
        }
    }
    
    if (messages.length > 100) trimMessages();
}
```

**Key Protections**:
- Max rounds (10)
- Max consecutive failures (3)
- Multi-point abort checking
- Message history limit (100)

### 3. WebView: CSP-Compliant, No External Dependencies ✅

**Critical Decision**: Do NOT use external CDN links (highlight.js, diff2html). They are blocked by VSCode's Content Security Policy.

**Implementation**:
```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'none'; 
               style-src ${webview.cspSource} 'unsafe-inline'; 
               script-src 'nonce-${nonce}';">
```

**What Works**:
- ✅ Inline styles with `'unsafe-inline'`
- ✅ Inline scripts with `nonce` mechanism
- ✅ `webview.cspSource` for local resources
- ❌ External CDN (blocked)

### 4. Fix Strategy: Context-Aware ✅
The agent receives:
1. The mssanitizer diagnostic (error type, file:line, memory space)
2. The source file content (with line numbers)
3. Relevant skill documentation (memory error patterns)
4. A system prompt instructing it to analyze and fix

**Prompt Engineering**:
- Skills loaded on-demand based on error type
- System prompt provides high-level guidance
- Task description includes specific error details

### 5. Path Resolution: Multi-Directory Search ✅

**Problem**: Log files contain relative paths, but we need absolute paths.

**Solution**:
1. Update `diagnostic.fileName` to absolute path during parsing
2. Search order:
   - Check if absolute and exists
   - Search in workspace root
   - Search in last log directory
   - Fallback to workspace root

### 6. AbortSignal: Getter Pattern ✅

**Problem**: Cancellation didn't work.

**Root Cause**: Snapshot vs real-time check.

**Solution**:
```typescript
// ❌ WRONG: Snapshot (doesn't update)
abortSignal: { aborted: token.isCancellationRequested }

// ✅ CORRECT: Getter (real-time)
abortSignal: { 
    get aborted() { 
        return token.isCancellationRequested; 
    } 
}
```

## Challenges & Solutions

### Challenge 1: WebView Completely Blank

**Symptom**: WebView opens but shows nothing, no right-click menu, no console access.

**Root Cause**: CSP blocks external CDN resources (highlight.js, diff2html).

**Solution**:
1. Remove ALL external CDN links
2. Use `webview.cspSource` and `nonce` mechanism
3. Inline all styles and scripts
4. Implement simple diff rendering without external libraries

**Lesson**: VSCode WebViews are security-restricted. Never rely on external resources.

### Challenge 2: Ollama Tool Call Parsing Failed

**Symptom**: Tool calls had empty arguments `{"_raw": ""}`.

**Root Cause**: Ollama sends tool calls as **complete objects**, not incremental deltas. Code assumed incremental accumulation.

**Solution**:
- Detect `tool_use_start` with complete parameters
- Handle arguments as string OR object
- Parse immediately instead of buffering

### Challenge 3: Agent Infinite Loop

**Symptom**: Agent keeps calling tools without stopping.

**Root Cause**: No failure counter, tool errors didn't stop the loop.

**Solution**:
- Add `MAX_CONSECUTIVE_FAILURES = 3`
- Check abort signal at multiple points
- Reset counter on success

### Challenge 4: Extension Not Activating

**Symptom**: Output channel doesn't appear, commands don't show.

**Root Cause**: `activationEvents` too restrictive (only command-based).

**Solution**:
```json
"activationEvents": [
    "onLanguage:cpp",  // Activate on C++ files
    "onCommand:..."
]
```

Create OutputChannel immediately in `activate()`.

### Challenge 5: Timeout Too Short

**Symptom**: Complex fixes timeout after 2 minutes.

**Root Cause**: Hardcoded 120000ms timeout, not configurable.

**Solution**:
- Make timeout configurable (`msagent.timeoutMs`)
- Increase default to 300000ms (5 minutes)
- Separate validation timeout (30000ms)

### Challenge 6: Side-by-Side Diff Not Showing

**Symptom**: Final diff message sent but not rendered.

**Root Cause**: WebView JavaScript didn't handle `final_diff` message type.

**Solution**: Implement `appendFinalDiff()` with table-based diff rendering.

## Risks and Mitigations

| Risk | Status | Mitigation |
|------|--------|------------|
| Local model quality insufficient | ✅ Mitigated | Detailed skill docs, structured prompts |
| Tool calling not supported | ✅ Mitigated | Ollama supports, handle complete objects |
| Large source files exceed context | ⚠️ Partial | Read specific line ranges, but no chunking yet |
| Fix may be incorrect | ✅ Mitigated | Side-by-side diff preview, user can reject |
| mssanitizer output format changes | ✅ Mitigated | Parser with error recovery, log unrecognized lines |
| **CSP blocks external resources** | ✅ Solved | Inline everything, use nonce |
| **Agent infinite loop** | ✅ Solved | Failure counter + abort checks |
| **Ollama format differences** | ✅ Solved | Handle reasoning + complete tool calls |

## Current State

### ✅ Fully Functional

- LLM streaming output in WebView
- Tool call visualization
- Side-by-side diff
- Cancellation support
- All 8 memory error types
- Path resolution
- Configuration validation
- Error handling

### ⚠️ Known Limitations

1. **No syntax highlighting** - CSP blocks external highlight.js
   - **Workaround**: Could download locally
   
2. **No advanced diff rendering** - CSP blocks diff2html
   - **Current**: Simple table-based diff
   
3. **Single-file fixes only** - Cannot fix across workspace
   - **Future**: Multi-file support

4. **No persistent conversation** - Each fix starts fresh
   - **Future**: Chat history retention

## Next Steps

### Phase 1: Polish (Optional)
- [ ] Download highlight.js locally for syntax highlighting
- [ ] Download diff2html locally for advanced diff
- [ ] Add keyboard shortcuts to package.json
- [ ] Add welcome message for first-time users

### Phase 2: Advanced Features
- [ ] TreeView for diagnostics sidebar
- [ ] Configuration wizard
- [ ] Multi-file fix support
- [ ] Persistent conversation history
- [ ] Custom tool definitions

### Phase 3: Testing & Quality
- [ ] Unit tests for parser
- [ ] Integration tests for agent loop
- [ ] E2E tests for full workflow
- [ ] Performance benchmarks

## Documentation

| Document | Purpose | Status |
|----------|---------|--------|
| SPEC.md | Technical specification | ✅ Complete |
| README.md | User documentation (Chinese) | ✅ Complete |
| README_EN.md | User documentation (English) | ✅ Complete |
| CHANGELOG.md | Version history | ✅ Complete |
| SKILL.md | VSCode extension dev lessons | ✅ Updated |

## Version History

- **v0.2.0** (2026-04-01): WebView streaming, tool visualization, diff view, cancellation
- **v0.1.0** (2026-04-01): Initial release, basic agent loop, diagnostics
