---
name: msagent-patterns
description: Coding patterns extracted from msAgent repository — VSCode extension for Ascend NPU memory error repair
version: 1.0.0
source: local-git-analysis
analyzed_commits: 6
---

# msAgent Patterns

## Commit Conventions

Mixed style — conventional commits preferred for feature work:

| Pattern | Examples |
|---------|----------|
| `feat:` | New features (`feat: programmatic parseLog, fixProblem`) |
| `docs:` | Documentation (`docs: Update RELEASE_NOTES.md`) |
| `!N` | Merge requests (`!1 merge docs/...`, `!2 merge integration`) |
| Imperative | Release commits (`Add test infrastructure`, `Release v0.2.0`) |

## Code Architecture

```
src/
├── agent/              # Agent loop: LLM ↔ Tool interaction
│   ├── agentLoop.ts    # Core loop (LLM call → tool exec → repeat)
│   └── message.ts      # Message types: TextContent, ToolCallContent, ToolResultContent
├── llm/                # LLM provider abstraction
│   ├── provider.ts     # Interface + toApiTool/toApiMessages converters
│   ├── openaiCompatProvider.ts  # OpenAI-compatible HTTP impl (Ollama, vLLM)
│   ├── config.ts       # VSCode settings reader
│   └── types.ts        # StreamChunk, StreamingLLMProvider
├── opencode/           # OpenCode provider (alternative LLM backend)
│   ├── openCodeProvider.ts
│   └── types.ts
├── parser/             # mssanitizer log parsing
│   ├── logParser.ts    # Regex-based parser → SanitizerDiagnostic[]
│   └── types.ts        # 8 MemErrorType enums, AddressSpace, BlockType, Severity
├── skills/             # Knowledge base for LLM prompts
│   ├── memcheck-skills.md  # Ascend C memory error repair knowledge
│   └── skillLoader.ts  # Prompt builder from skills + diagnostics
├── tools/              # Tool implementations for agent loop
│   └── toolHandlers.ts # read_file, edit_file, list_files, read_diagnostics
├── vscode/             # VSCode integration layer
│   ├── diagnosticsManager.ts  # Log → Problems panel
│   ├── codeActionProvider.ts  # CodeAction quick fix
│   └── fixService.ts          # Fix orchestration + WebView
├── webview/            # WebView for streaming LLM output
│   ├── messages.ts     # Message definitions (extension ↔ webview)
│   └── webviewPanelProvider.ts
├── extension.ts        # Entry point, command registration
└── test/               # Test infrastructure
    ├── setup.ts        # Fixture path helpers
    └── mocks/vscode.ts # VSCode API mock for unit testing
```

## Key Design Patterns

### 1. LLM Provider Abstraction
`LLMProvider` interface in `provider.ts` with `OpenAICompatProvider` implementation. `streamChat` falls back to `chat` + yields chunks. New providers (OpenCode) implement the same interface.

### 2. Tool-Based Agent Loop
`agentLoop.ts` drives: LLM call → parse tool_use → `executeTool()` → feed result back → repeat until `end_turn`. Tools defined as `ToolHandler` objects with `name`, `inputSchema`, `execute()`.

### 3. Regex-Based Log Parsing
`logParser.ts` groups mssanitizer log lines by `======` headers, classifies into 8 `MemErrorType` values, extracts address/space/block/stack info.

### 4. VSCode Settings → Config Object
`config.ts` reads `vscode.workspace.getConfiguration('msagent')` once per call. Settings: `modelEndpoint`, `modelName`, `apiKey`, `temperature`, `maxTokens`, `timeoutMs`, `provider`.

## Workflows

### Adding a New Memory Error Type
1. Add enum value to `MemErrorType` in `parser/types.ts`
2. Add classification logic in `logParser.ts` `classifyError()`
3. Add a test fixture in `test/fixtures/{error_type}.log`
4. Add parsing test in `parser/logParser.test.ts`
5. Add repair knowledge in `skills/memcheck-skills.md`

### Adding a New Tool for the Agent
1. Define `ToolHandler` object in `tools/toolHandlers.ts`
2. Add to `ALL_TOOLS` array (auto-registered)
3. Add tool tests in `tools/toolHandlers.test.ts`

### Adding a New LLM Provider
1. Implement `LLMProvider` interface from `provider.ts`
2. Add provider type to `config.ts` `ProviderType`
3. Wire into `fixService.ts` provider creation
4. Test with mock HTTP server (see `openaiCompatProvider.test.ts`)

## Testing Patterns

- **Framework**: Mocha + Chai (expect style) + Sinon
- **Config**: `.mocharc.yml` with `ts-node/register`, spec glob `src/**/*.test.ts`
- **Test location**: Co-located `*.test.ts` next to source files
- **Fixtures**: `test/fixtures/*.log` (mssanitizer logs), `test/fixtures-src/*.cpp` (source code)
- **VSCode mock**: `src/test/mocks/vscode.ts` for unit testing modules that import vscode
- **Coverage**: `c8 mocha` — target 80%+ (currently at 90%)
- **HTTP testing**: Real `http.Server` on localhost for `openaiCompatProvider` tests
- **File testing**: `os.tmpdir()` + `fs.mkdtempSync` with `afterEach` cleanup

### Test Structure (AAA)
```typescript
it('should replace exact text in file', async () => {
    // Arrange
    const filePath = path.join(tmpDir, 'test.cpp');
    fs.writeFileSync(filePath, 'int x = 0;\n');

    // Act
    const result = await executeTool('edit_file', { path: filePath, oldText: 'int x = 0;', newText: 'int x = 42;' }, ctx);

    // Assert
    expect(result).to.include('Success');
    expect(fs.readFileSync(filePath, 'utf-8')).to.include('int x = 42;');
});
```

## Naming Conventions

| Category | Convention | Example |
|----------|-----------|---------|
| Error types | UPPER_SNAKE_CASE enum | `OUT_OF_BOUNDS`, `MEM_LEAK` |
| Source files | camelCase.ts | `logParser.ts`, `fixService.ts` |
| Test files | camelCase.test.ts | `logParser.test.ts` |
| Interfaces | PascalCase | `SanitizerDiagnostic`, `ToolContext` |
| Functions | camelCase | `parseLog()`, `executeTool()` |
| Constants (regex) | UPPER_SNAKE_CASE | `HEADER_RE`, `DETAIL_RE` |
| VSCode commands | dot-prefix | `msagent.parseLog`, `msagent.fixAll` |
| Settings | dot-prefix | `msagent.modelEndpoint`, `msagent.apiKey` |

## 8 Memory Error Types

| Type | Severity | Log Pattern |
|------|----------|-------------|
| `OUT_OF_BOUNDS` | WARNING | "out of bounds of size N" |
| `ILLEGAL_ADDR_READ` | ERROR | "illegal read of size N" |
| `ILLEGAL_ADDR_WRITE` | ERROR | "illegal write of size N" |
| `MISALIGNED_ACCESS` | ERROR | "misaligned access of size N" |
| `MEM_LEAK` | ERROR | "Direct leak of N byte(s)" |
| `ILLEGAL_FREE` | ERROR | "illegal free()" |
| `MEM_UNUSED` | WARNING | "Unused memory of N byte(s)" |
| `UNINITIALIZED_READ` | ERROR | "uninitialized read of size N" |
