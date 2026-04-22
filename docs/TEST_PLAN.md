# msAgent 测试计划

## 已完成工作

1. **配置测试基础设施**
   - Updated package.json scripts: added `test` and `test:coverage`
   - Fixed .mocharc.yml: corrected from `extension: ts-node/register/register` to `require: ts-node/register`
   - Verified TypeScript compiles cleanly
   - All dependencies (mocha, chai, c8, sinon, ts-node) installed

2. **实现 T1 测试（日志解析器）**
   - Created `src/parser/logParser.test.ts`
   - 13 passing tests covering:
     - All 8 error type fixtures
     - Mixed errors
     - No errors
     - Non-existent files
     - Empty strings
     - Whitespace-only logs
   - Coverage: 93.88%
   - Run via: `npm test` or `npm run test:coverage`

## 待完成测试

### Phase 1: T2 - LLM 通信测试
- File: `src/llm/openaiCompatProvider.test.ts`
- Goals:
  - Test LLMProviderError types (CONNECTION_REFUSED, TIMEOUT, etc.)
  - Test `toApiMessages` conversion
  - Test basic chat with mock server
  - Test streaming response parsing

### Phase 2: T3 - LLM 工具调用测试
- File: `src/llm/openaiCompatProvider.test.ts` (continued)
- Goals:
  - Verify tool_use generation from LLM
  - Verify tool_calls → our internal message type conversion
  - Verify tool result handling

### Phase 3: T4 - Agent 循环测试
- File: `src/agent/agentLoop.test.ts`
- Goals:
  - Mock LLM to test message accumulation
  - Verify maxToolRounds enforcement
  - Verify abort signal handling
  - Verify tool execution flow

### Phase 4: T6 - 错误恢复测试
- File: `src/parser/logParser.test.ts` (coverage for edge cases)
- Files: `src/llm/openaiCompatProvider.test.ts`, `src/tools/toolHandlers.test.ts`
- Goals:
  - Test all edge cases in log parsing
  - Test tool handlers (read_file, edit_file, list_files, read_diagnostics) with edge cases

### Phase 5: 工具处理测试
- File: `src/tools/toolHandlers.test.ts`
- Goals:
  - Test file reading (normal, non-existent, permission denied)
  - Test file editing (normal, non-existent file, invalid oldText)
  - Test file listing
  - Test diagnostics reading

### Phase 6: 配置管理测试
- File: `src/llm/config.test.ts`
- Goals:
  - Test VSCode config reading with mocked vscode API
  - Test default values
  - Test validation

### Phase 7: 技能加载测试
- File: `src/skills/skillLoader.test.ts`
- Goals:
  - Test skill loading from file
  - Test prompt construction with skills
  - Test fallback if skill file missing

### Phase 8: 诊断管理器测试
- File: `src/vscode/diagnosticsManager.test.ts`
- Goals:
  - Test adding diagnostics to VSCode
  - Test clearing diagnostics
  - Test matching diagnostics to files/line numbers

### Phase 9: CodeAction 提供者测试
- File: `src/vscode/codeActionProvider.test.ts`
- Goals:
  - Test quick fix menu generation
  - Test fix trigger

### Phase 10: 修复服务测试
- File: `src/vscode/fixService.test.ts`
- Goals:
  - Test fix orchestration
  - Test WebView messaging
  - Test status bar updates

## 测试执行命令

```bash
# 编译 TypeScript
npm run compile

# 运行所有测试
npm test

# 运行测试并显示覆盖率
npm run test:coverage

# 运行单个测试文件
npx mocha src/parser/logParser.test.ts
```

## 测试覆盖目标

- Core logic (logParser, agentLoop, llmProvider): ≥90% coverage
- Tool handlers: ≥85% coverage
- VSCode integration: ≥70% coverage (focus on critical paths)

## 里程碑

- ✅ M1: Log parser tests complete (13 passing, 93.88% coverage)
- ⏳ M2: LLM communication tests
- ⏳ M3: Agent loop tests
- ⏳ M4: Tool handlers tests
- ⏳ M5: Full coverage report ≥85%
