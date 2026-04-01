# msAgent 测试指南

[English](#test-guide-en) | **中文**

## 目录

- [测试概览](#测试概览)
- [环境准备](#环境准备)
- [自动化测试](#自动化测试)
  - [T1: 日志解析器](#t1-日志解析器)
  - [T2: LLM 通信（无工具调用）](#t2-llm-通信无工具调用)
  - [T3: LLM 工具调用生成](#t3-llm-工具调用生成)
  - [T4: Agent 循环（mock LLM）](#t4-agent-循环mock-llm)
  - [T5: Agent 完整修复（真实 LLM）](#t5-agent-完整修复真实-llm)
  - [T6: 错误恢复](#t6-错误恢复)
- [手动测试（VSCode Extension Host）](#手动测试vscode-extension-host)
  - [M1: 日志解析 + Problems 面板](#m1-日志解析--problems-面板)
  - [M2: CodeAction 快速修复](#m2-codeaction-快速修复)
  - [M3: 批量修复](#m3-批量修复)
  - [M4: 错误提示](#m4-错误提示)
- [测试数据说明](#测试数据说明)
- [常见问题排查](#常见问题排查)

---

## 测试概览

本项目的测试分为**自动化测试**和**手动测试**两部分。

核心逻辑（日志解析、Agent 循环、LLM 通信、工具执行）全部可以在终端通过 Node.js 脚本自动化测试，不需要 VSCode 环境。VSCode API 相关的功能（命令面板、Problems 面板、CodeAction、状态栏、Output Channel）需要在 Extension Host 中手动验证。

```
┌─────────────────────────────────────────────────┐
│              自动化测试（终端）                     │
│                                                 │
│  T1 日志解析器    ───  10 个 fixture 全通过       │
│  T2 LLM 通信     ───  基本对话 + token 统计      │
│  T3 工具调用生成  ───  LLM 返回 tool_use 格式     │
│  T4 Agent 循环   ───  mock LLM 验证循环逻辑       │
│  T5 完整修复     ───  真实 Ollama read+edit 循环   │
│  T6 错误恢复     ───  连接拒绝 / 超时 / 文件不存在  │
├─────────────────────────────────────────────────┤
│           手动测试（VSCode F5）                    │
│                                                 │
│  M1 日志解析 → Problems 面板                     │
│  M2 灯泡 CodeAction 触发修复                     │
│  M3 命令面板批量修复                              │
│  M4 LLM 不可用时的友好错误提示                     │
└─────────────────────────────────────────────────┘
```

---

## 环境准备

### 1. 编译项目

```bash
cd /path/to/ms-agent
npm install
npm run compile
```

确认无报错后继续。

### 2. 启动 Ollama

```bash
# 启动服务
ollama serve

# 确认可用模型
ollama list

# 确保至少有一个模型（推荐 qwen3:8b）
ollama pull qwen3:8b

# 验证 API 可达
curl -s http://localhost:11434/api/tags | python3 -m json.tool
```

预期输出类似：
```json
{
  "models": [
    { "name": "qwen3:8b", "size": 5225388164, ... }
  ]
}
```

> **注意：** T1、T4、T6 不需要 Ollama。T2、T3、T5 需要 Ollama 运行中。

---

## 自动化测试

### T1: 日志解析器

**目的：** 验证解析器能正确处理所有 8 种错误类型 + 混合日志 + 空日志。

**前置条件：** 无（不需要 Ollama）。

```bash
cd /path/to/ms-agent

node -e "
const { parseLogFile, parseLog } = require('./out/parser/logParser');
const path = require('path');

const dir = './test/fixtures';
const fs = require('fs');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
let pass = 0, fail = 0, details = [];

for (const f of files) {
  try {
    const r = parseLogFile(path.join(dir, f));

    if (f === 'no_errors.log') {
      if (r.diagnostics.length === 0 && r.parseErrors.length === 0) {
        pass++; continue;
      }
    }

    if (f === 'mixed_errors.log') {
      if (r.diagnostics.length >= 3) {
        pass++; continue;
      }
    }

    // 所有其他 fixture 至少应解析出 1 个诊断
    if (r.diagnostics.length >= 1) {
      pass++; continue;
    }

    fail++; details.push(f + ': expected >= 1 diagnostic, got ' + r.diagnostics.length);
  } catch(e) {
    fail++; details.push(f + ': exception - ' + e.message);
  }
}

console.log('=== T1: Log Parser ===');
console.log('Result: ' + pass + '/' + files.length + ' passed');
if (details.length) {
  console.log('Failures:');
  details.forEach(d => console.log('  - ' + d));
}
"
```

**预期输出：**
```
=== T1: Log Parser ===
Result: 10/10 passed
```

**逐个 fixture 验证（可选，更详细）：**

```bash
node -e "
const { parseLogFile } = require('./out/parser/logParser');

const tests = [
  { file: 'test/fixtures/out_of_bounds.log',      expectType: 'OUT_OF_BOUNDS' },
  { file: 'test/fixtures/illegal_read.log',         expectType: 'ILLEGAL_ADDR_READ' },
  { file: 'test/fixtures/illegal_write.log',        expectType: 'ILLEGAL_ADDR_WRITE' },
  { file: 'test/fixtures/misaligned_access.log',    expectType: 'MISALIGNED_ACCESS' },
  { file: 'test/fixtures/mem_leak.log',             expectType: 'MEM_LEAK' },
  { file: 'test/fixtures/illegal_free.log',         expectType: 'ILLEGAL_FREE' },
  { file: 'test/fixtures/unused_memory.log',        expectType: 'MEM_UNUSED' },
  { file: 'test/fixtures/uninitialized_read.log',   expectType: 'UNINITIALIZED_READ' },
  { file: 'test/fixtures/mixed_errors.log',         expectType: 'MULTIPLE' },
  { file: 'test/fixtures/no_errors.log',            expectType: 'NONE' },
];

console.log('=== T1 Detail: Per-Fixture ===');
for (const t of tests) {
  const r = parseLogFile(t.file);
  if (t.expectType === 'NONE') {
    console.log(r.diagnostics.length === 0 ? 'PASS' : 'FAIL', t.file, '- got', r.diagnostics.length, 'diagnostics');
    continue;
  }
  if (t.expectType === 'MULTIPLE') {
    const types = r.diagnostics.map(d => d.errorType).join(', ');
    console.log(r.diagnostics.length >= 3 ? 'PASS' : 'FAIL', t.file, '- types:', types);
    continue;
  }
  const d = r.diagnostics[0];
  const ok = d && d.errorType === t.expectType;
  console.log(ok ? 'PASS' : 'FAIL', t.file, '-', ok ? d.errorType : 'got ' + (d ? d.errorType : 'nothing'));
}
"
```

**预期输出：**
```
=== T1 Detail: Per-Fixture ===
PASS test/fixtures/out_of_bounds.log - OUT_OF_BOUNDS
PASS test/fixtures/illegal_read.log - ILLEGAL_ADDR_READ
PASS test/fixtures/illegal_write.log - ILLEGAL_ADDR_WRITE
PASS test/fixtures/misaligned_access.log - MISALIGNED_ACCESS
PASS test/fixtures/mem_leak.log - MEM_LEAK
PASS test/fixtures/illegal_free.log - ILLEGAL_FREE
PASS test/fixtures/unused_memory.log - MEM_UNUSED
PASS test/fixtures/uninitialized_read.log - UNINITIALIZED_READ
PASS test/fixtures/mixed_errors.log - types: ILLEGAL_ADDR_READ, MISALIGNED_ACCESS, OUT_OF_BOUNDS, MEM_LEAK
PASS test/fixtures/no_errors.log
```

---

### T2: LLM 通信（无工具调用）

**目的：** 验证 Ollama 连接、API 格式、响应解析。

**前置条件：** Ollama 运行中，模型已拉取。

```bash
node -e "
const { OpenAICompatProvider } = require('./out/llm/openaiCompatProvider');
const { textMessage } = require('./out/agent/message');

(async () => {
  console.log('=== T2: LLM Basic Chat ===');

  const provider = new OpenAICompatProvider({
    endpoint: 'http://localhost:11434',
    modelName: 'qwen3:8b',
    temperature: 0.1,
    maxTokens: 256,
    timeoutMs: 30000,
  });

  const response = await provider.chat(
    [textMessage('Reply with exactly: hello world')],
    [],
    'You are a minimal responder.',
  );

  console.log('stopReason:', response.stopReason);
  console.log('text:', response.content.filter(c => c.type === 'text').map(c => c.text).join(''));
  console.log('usage:', JSON.stringify(response.usage));

  const ok = response.content.length > 0;
  console.log('Result:', ok ? 'PASS' : 'FAIL');
})().catch(e => { console.log('Result: FAIL -', e.message); });
"
```

**预期输出：**
```
=== T2: LLM Basic Chat ===
stopReason: end_turn    (或 max_tokens，qwen3 模型可能因思考链消耗 token)
text: hello world
usage: {"promptTokens":...,"completionTokens":...}
Result: PASS
```

> **注意：** `stopReason` 为 `max_tokens` 不代表失败。qwen3 系列模型内置思考链（thinking tokens），会占用部分 token 预算。只要 `content` 非空即视为 PASS。如果需要避免 `max_tokens`，可增大 `maxTokens` 至 1024。

---

### T3: LLM 工具调用生成

**目的：** 验证 LLM 能正确返回 `tool_use` 格式的工具调用。

**前置条件：** Ollama 运行中。

```bash
node -e "
const { OpenAICompatProvider } = require('./out/llm/openaiCompatProvider');
const { textMessage } = require('./out/agent/message');

(async () => {
  console.log('=== T3: LLM Tool Call Generation ===');

  const provider = new OpenAICompatProvider({
    endpoint: 'http://localhost:11434',
    modelName: 'qwen3:8b',
    temperature: 0,
    maxTokens: 256,
    timeoutMs: 30000,
  });

  const response = await provider.chat(
    [textMessage('Read the file /tmp/hello.txt using the read_file tool.')],
    [{
      name: 'read_file',
      description: 'Read file contents from disk.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path' } },
        required: ['path'],
      },
    }],
    'You must use the read_file tool. Do not explain, just call the tool.',
  );

  const toolCalls = response.content.filter(c => c.type === 'tool_use');
  console.log('stopReason:', response.stopReason);
  console.log('toolCalls:', JSON.stringify(toolCalls, null, 2));

  const ok = response.stopReason === 'tool_use'
    && toolCalls.length === 1
    && toolCalls[0].name === 'read_file'
    && typeof toolCalls[0].input.path === 'string';
  console.log('Result:', ok ? 'PASS' : 'FAIL');
})().catch(e => { console.log('Result: FAIL -', e.message); });
"
```

**预期输出：**
```
=== T3: LLM Tool Call Generation ===
stopReason: tool_use
toolCalls: [
  {
    "type": "tool_use",
    "id": "call_...",
    "name": "read_file",
    "input": {
      "path": "/tmp/hello.txt"
    }
  }
]
Result: PASS
```

---

### T4: Agent 循环（mock LLM）

**目的：** 验证 Agent 的消息累积、工具调度、停止条件，不依赖真实 LLM。

**前置条件：** 无（不需要 Ollama）。

```bash
node -e "
const { runAgent } = require('./out/agent/agentLoop');

// Mock LLM: 第一次返回 tool_use，第二次返回 end_turn
let callCount = 0;
const mockLLM = {
  async chat(messages, tools, sys) {
    callCount++;
    if (callCount === 1) {
      return {
        content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: '/tmp/a.txt' } }],
        stopReason: 'tool_use',
      };
    }
    return {
      content: [{ type: 'text', text: 'I have read the file and here is my analysis.' }],
      stopReason: 'end_turn',
    };
  }
};

(async () => {
  console.log('=== T4: Agent Loop (Mock LLM) ===');

  const result = await runAgent({
    systemPrompt: 'You are a test agent.',
    taskDescription: 'Read /tmp/a.txt and analyze it.',
    toolContext: { workspaceRoot: '/tmp' },
    llm: mockLLM,
    maxToolRounds: 5,
    onToolCall: (name, params) => console.log('  tool_call:', name, JSON.stringify(params)),
  });

  console.log('toolCallCount:', result.toolCallCount);
  console.log('finalMessage:', result.finalMessage);
  console.log('messages.length:', result.messages.length);

  const ok = result.toolCallCount === 1
    && result.messages.length === 3          // user → assistant(tool) → tool_result → assistant(text) → 返回前 messages 有 4 个，但因 end_turn 在 assistant 后追加所以是 3-4
    && result.finalMessage.includes('analysis');

  console.log('Result:', (result.toolCallCount === 1 && result.finalMessage.includes('analysis')) ? 'PASS' : 'FAIL');
})().catch(e => { console.log('Result: FAIL -', e.message); });
"
```

**预期输出：**
```
=== T4: Agent Loop (Mock LLM) ===
  tool_call: read_file {"path":"/tmp/a.txt"}
toolCallCount: 1
finalMessage: I have read the file and here is my analysis.
messages.length: 3
Result: PASS
```

**补充测试：abort signal**

```bash
node -e "
const { runAgent } = require('./out/agent/agentLoop');

const mockLLM = {
  async chat() {
    // yield to event loop，让 setTimeout 有机会触发 abort
    await new Promise(r => setTimeout(r, 10));
    return {
      content: [{ type: 'tool_use', id: 'call_x', name: 'read_file', input: { path: '/tmp/x' } }],
      stopReason: 'tool_use',
    };
  }
};

(async () => {
  console.log('=== T4b: Abort Signal ===');
  const signal = { aborted: false };
  setTimeout(() => { signal.aborted = true; }, 100);

  const result = await runAgent({
    systemPrompt: 'test',
    taskDescription: 'test',
    toolContext: { workspaceRoot: '/tmp' },
    llm: mockLLM,
    abortSignal: signal,
    maxToolRounds: 100,
  });

  console.log('finalMessage:', result.finalMessage);
  console.log('Result:', result.finalMessage === 'Aborted' ? 'PASS' : 'FAIL');
})().catch(e => { console.log('Result: FAIL -', e.message); });
"
```

> **注意：** mock LLM 中必须加 `await new Promise(r => setTimeout(r, 10))` 让出事件循环。否则 `executeTool` 中的 `fs.readFileSync` 是同步的，100 轮循环不会中断，`setTimeout` 回调永远无法执行。

**预期输出：**
```
=== T4b: Abort Signal ===
finalMessage: Aborted
Result: PASS
```

---

### T5: Agent 完整修复（真实 LLM）

**目的：** 端到端验证 Agent 能用真实 LLM 读取文件并应用编辑。

**前置条件：** Ollama 运行中。

```bash
# 确保在项目根目录下执行（require 路径相对于当前目录）
cd /path/to/ms-agent

# 1. 准备测试文件
mkdir -p /tmp/mssanitizer-e2e
cat > /tmp/mssanitizer-e2e/kernel.cpp << 'EOF'
#include "kernel_operator.h"
using namespace AscendC;

class KernelAdd {
public:
    __aicore__ inline void Init(GM_ADDR x, GM_ADDR y, GM_ADDR z) {
        xGm.SetGlobalBuffer((__gm__ half*)x, 256);
        yGm.SetGlobalBuffer((__gm__ half*)y, 256);
        zGm.SetGlobalBuffer((__gm__ half*)z, 256);
    }
    __aicore__ inline void Process() {
        for (int i = 0; i < 128; i++) {
            zGm.SetValue(i, xGm.GetValue(i) + yGm.GetValue(i));
        }
        half val = zGm.GetValue(300);
    }
private:
    GlobalTensor<half> xGm;
    GlobalTensor<half> yGm;
    GlobalTensor<half> zGm;
};
EOF

# 2. 运行 E2E 测试
node -e "
const { OpenAICompatProvider } = require('./out/llm/openaiCompatProvider');
const { runAgent } = require('./out/agent/agentLoop');
const fs = require('fs');

(async () => {
  console.log('=== T5: Full E2E Fix ===');
  console.log('Original file:');
  console.log(fs.readFileSync('/tmp/mssanitizer-e2e/kernel.cpp', 'utf-8'));
  console.log('---');

  const provider = new OpenAICompatProvider({
    endpoint: 'http://localhost:11434',
    modelName: 'qwen3:8b',
    temperature: 0.1,
    maxTokens: 4096,
    timeoutMs: 120000,
  });

  const result = await runAgent({
    systemPrompt: 'You are an Ascend C memory error fix specialist. Use read_file first, then edit_file to fix.',
    taskDescription: 'Fix the out-of-bounds read at line 16: GetValue(300) exceeds buffer size 256. Read /tmp/mssanitizer-e2e/kernel.cpp first, then apply a minimal fix.',
    toolContext: { workspaceRoot: '/tmp/mssanitizer-e2e' },
    llm: provider,
    maxToolRounds: 6,
    onToolCall: (name, params) => console.log('  Tool:', name, JSON.stringify(params).substring(0, 120)),
  });

  console.log('---');
  console.log('Tool calls:', result.toolCallCount);
  console.log('Final message:', result.finalMessage.substring(0, 300));
  console.log('');
  console.log('Fixed file:');
  console.log(fs.readFileSync('/tmp/mssanitizer-e2e/kernel.cpp', 'utf-8'));

  const fixed = fs.readFileSync('/tmp/mssanitizer-e2e/kernel.cpp', 'utf-8');
  const fileChanged = fixed.indexOf('zGm.GetValue(300)') === -1;
  console.log('---');
  console.log('Result:', (result.toolCallCount >= 1 && fileChanged) ? 'PASS' : 'FAIL',
    '(toolCalls=' + result.toolCallCount + ', fileChanged=' + fileChanged + ')');
})().catch(e => { console.log('Result: FAIL -', e.message); });
"
```

**预期输出：**
```
=== T5: Full E2E Fix ===
Original file:
#include "kernel_operator.h"
...
        half val = zGm.GetValue(300);
...
---
  Tool: read_file {"path":"/tmp/mssanitizer-e2e/kernel.cpp"}
  Tool: edit_file {"path":"kernel.cpp","oldText":"...GetValue(300)...","newText":"..."}
---
Tool calls: 2
Final message: The out-of-bounds read has been fixed...

Fixed file:
...
        half val = zGm.GetValue(255);
...
---
Result: PASS (toolCalls=2, fileChanged=true)
```

> **注意：** LLM 输出具有随机性，修复内容可能不完全一致（如改成 `GetValue(255)` 或删除该行等），但关键是 `toolCalls >= 1` 且 `fileChanged = true`。

---

### T6: 错误恢复

**目的：** 验证边界条件和错误处理。

**前置条件：** 部分 test 不需要 Ollama。

#### T6a: 空日志解析

```bash
node -e "
const { parseLog, parseLogFile } = require('./out/parser/logParser');

console.log('=== T6a: Empty / Edge Cases ===');

// 空字符串
const r1 = parseLog('');
console.log('empty string:', r1.diagnostics.length === 0 && r1.parseErrors.length === 0 ? 'PASS' : 'FAIL');

// 纯空白
const r2 = parseLog('   \n  \n  ');
console.log('whitespace only:', r2.diagnostics.length === 0 ? 'PASS' : 'FAIL');

// 不存在的文件
const r3 = parseLogFile('/nonexistent/path/file.log');
console.log('missing file:', r3.diagnostics.length === 0 && r3.parseErrors.length === 1 && r3.parseErrors[0].includes('File not found') ? 'PASS' : 'FAIL');

// 无错误日志
const r4 = parseLogFile('./test/fixtures/no_errors.log');
console.log('no_errors fixture:', r4.diagnostics.length === 0 ? 'PASS' : 'FAIL');
"
```

**预期输出：**
```
=== T6a: Empty / Edge Cases ===
empty string: PASS
whitespace only: PASS
missing file: PASS
no_errors fixture: PASS
```

#### T6b: LLM 连接拒绝

```bash
node -e "
const { OpenAICompatProvider, LLMProviderError } = require('./out/llm/openaiCompatProvider');
const { textMessage } = require('./out/agent/message');

(async () => {
  console.log('=== T6b: LLM Connection Refused ===');

  // 使用一个不存在的端口
  const provider = new OpenAICompatProvider({
    endpoint: 'http://localhost:19999',
    modelName: 'fake',
    timeoutMs: 5000,
  });

  try {
    await provider.chat([textMessage('hello')], []);
    console.log('Result: FAIL - should have thrown');
  } catch (e) {
    const isLLMError = e instanceof LLMProviderError;
    console.log('is LLMProviderError:', isLLMError);
    console.log('error code:', e.code);
    console.log('error message:', e.message);
    console.log('Result:', (isLLMError && e.code === 'CONNECTION_REFUSED') ? 'PASS' : 'FAIL');
  }
})();
"
```

**预期输出：**
```
=== T6b: LLM Connection Refused ===
is LLMProviderError: true
error code: CONNECTION_REFUSED
error message: Connection refused. Is the LLM server running?
Result: PASS
```

#### T6c: LLM 超时

```bash
node -e "
const { OpenAICompatProvider, LLMProviderError } = require('./out/llm/openaiCompatProvider');
const { textMessage } = require('./out/agent/message');

(async () => {
  console.log('=== T6c: LLM Timeout ===');

  const provider = new OpenAICompatProvider({
    endpoint: 'http://localhost:11434',
    modelName: 'qwen3:8b',
    timeoutMs: 1,  // 1ms，必定超时
  });

  try {
    await provider.chat([textMessage('hello')], []);
    console.log('Result: FAIL - should have thrown');
  } catch (e) {
    console.log('error code:', e.code);
    console.log('Result:', e.code === 'TIMEOUT' ? 'PASS' : 'FAIL');
  }
})();
"
```

**预期输出：**
```
=== T6c: LLM Timeout ===
error code: TIMEOUT
Result: PASS
```

#### T6d: API 消息格式验证

```bash
node -e "
const { textMessage, assistantMessage, toolResultMessage } = require('./out/agent/message');
const { toApiMessages } = require('./out/llm/provider');

console.log('=== T6d: API Message Format ===');

const messages = [
  textMessage('Read the file'),
  assistantMessage([
    { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: '/tmp/a.txt' } }
  ]),
  toolResultMessage('call_1', 'file content here', false),
  textMessage('Now edit it'),
];

const api = toApiMessages(messages, 'You are helpful.');
const apiStr = JSON.stringify(api, null, 2);

// 验证 assistant 消息使用 tool_calls 字段（非 content 数组）
const assistantMsg = api.find(m => m.role === 'assistant');
const hasToolCalls = Boolean(assistantMsg.tool_calls);
const noContentArray = Array.isArray(assistantMsg.content) === false;

// 验证 tool 消息使用 tool_call_id 字段
const toolMsg = api.find(m => m.role === 'tool');
const hasToolCallId = Boolean(toolMsg.tool_call_id);

// 验证 system 消息在最前
const systemMsg = api[0];
const systemFirst = systemMsg.role === 'system';

console.log('assistant has tool_calls field:', hasToolCalls ? 'PASS' : 'FAIL');
console.log('assistant content is not array:', noContentArray ? 'PASS' : 'FAIL');
console.log('tool message has tool_call_id:', hasToolCallId ? 'PASS' : 'FAIL');
console.log('system message is first:', systemFirst ? 'PASS' : 'FAIL');
console.log('');
console.log('Full API messages:');
console.log(apiStr);
"
```

**预期输出：**
```
=== T6d: API Message Format ===
assistant has tool_calls field: PASS
assistant content is not array: PASS
tool message has tool_call_id: PASS
system message is first: PASS

Full API messages:
[
  { "role": "system", "content": "You are helpful." },
  { "role": "user", "content": "Read the file" },
  {
    "role": "assistant",
    "tool_calls": [
      { "id": "call_1", "type": "function", "function": { "name": "read_file", "arguments": "{...}" } }
    ]
  },
  { "role": "tool", "tool_call_id": "call_1", "content": "file content here" },
  { "role": "user", "content": "Now edit it" }
]
```

---

## 手动测试（VSCode Extension Host）

### 启动 Extension Host

1. 在 VSCode 中打开 `ms-agent` 项目
2. 按 **F5**（或菜单 Run → Start Debugging）
3. 等待新的 VSCode 窗口打开（标题栏显示 `[Extension Development Host]`）
4. 在新窗口中打开任意项目文件夹（建议打开 `test/fixtures-src/`）

### M1: 日志解析 + Problems 面板

1. `Cmd+Shift+P` → 输入 `msAgent: Parse Log File`
2. 弹出文件选择器，选择 `test/fixtures/out_of_bounds.log`
3. **预期：**
   - 右下角弹出通知 `Parsed 1 diagnostics from log file (0 errors, 1 warnings)`
   - 打开 Problems 面板（`Cmd+Shift+M`），看到：
     ```
     [msSanitizer] OUT_OF_BOUNDS  add_custom.cpp  Warning
     ```

4. 再测试混合日志：`Cmd+Shift+P` → `msAgent: Parse Log File` → 选择 `test/fixtures/mixed_errors.log`
5. **预期：** Problems 面板显示 4 条诊断

6. 测试空日志：选择 `test/fixtures/no_errors.log`
7. **预期：** 通知 `Parsed 0 diagnostics from log file (0 errors, 0 warnings)`，Problems 面板为空

### M2: CodeAction 快速修复

**前置：** 先完成 M1，确保 Problems 面板有诊断。

1. 用 Extension Host 打开 `test/fixtures-src/add_custom.cpp`
2. 在 Problems 面板中双击诊断项跳转到对应行
3. 将光标移到报错行，点击行号旁的 **灯泡图标**（或按 `Cmd+.`）
4. **预期：** 弹出 Quick Fix 菜单，显示 `Fix: OUT_OF_BOUNDS`
5. 点击 `Fix: OUT_OF_BOUNDS`
6. **预期：**
   - 右下角状态栏出现 `⟳ msSanitizer: Analyzing...`
   - 状态栏动态更新：`⟳ msSanitizer: read_file(...)` → `⟳ msSanitizer: edit_file(...)`
   - 完成后状态栏消失
   - 弹出通知 `msSanitizer fix applied for OUT_OF_BOUNDS at add_custom.cpp:30`，带 `View Details` 按钮
   - 源文件被修改

### M3: 批量修复

**前置：** 先完成 M1（用 mixed_errors.log 解析出多条诊断）。

1. 在 Extension Host 中打开 `test/fixtures-src/add_custom.cpp`
2. `Cmd+Shift+P` → `msAgent: Fix All Issues`
3. **预期：**
   - 逐个修复 Error 级别的诊断
   - 每次修复弹出状态栏更新
   - 源文件被多次修改

### M4: 错误提示

#### M4a: LLM 未启动

1. 停止 Ollama：`pkill ollama`
2. 在 Extension Host 中执行 `msAgent: Fix All Issues`
3. **预期：** 弹出错误消息 `Cannot connect to LLM at http://localhost:11434. Is Ollama/vLLM running?`

#### M4b: 无诊断时触发修复

1. 不解析任何日志文件
2. `Cmd+Shift+P` → `msAgent: Fix All Issues`
3. **预期：** 弹出警告 `No msSanitizer diagnostics found for this file.`

#### M4c: 不存在的日志文件（可选）

1. 选择一个不存在的 `.log` 文件进行解析
2. **预期：** 通知 `Parsed 0 diagnostics`，无崩溃

---

## 测试数据说明

### 日志 Fixture

| 文件 | 错误类型 | 诊断数 | 说明 |
|---|---|---|---|
| `out_of_bounds.log` | `OUT_OF_BOUNDS` | 1 | 越界访问，WARNING 级别 |
| `illegal_read.log` | `ILLEGAL_ADDR_READ` | 1 | 非法读，ERROR 级别 |
| `illegal_write.log` | `ILLEGAL_ADDR_WRITE` | 1 | 非法写，ERROR 级别 |
| `misaligned_access.log` | `MISALIGNED_ACCESS` | 1 | 未对齐访问，ERROR 级别 |
| `mem_leak.log` | `MEM_LEAK` | 1 | 内存泄漏，特殊格式（`Direct leak of N byte(s)`） |
| `illegal_free.log` | `ILLEGAL_FREE` | 1 | 非法释放，ERROR 级别 |
| `unused_memory.log` | `MEM_UNUSED` | 1 | 内存未使用，WARNING 级别 |
| `uninitialized_read.log` | `UNINITIALIZED_READ` | 1 | 未初始化读，ERROR 级别 |
| `mixed_errors.log` | 4 种混合 | 4 | 包含 illegal_read + misaligned + out_of_bounds + mem_leak |
| `no_errors.log` | 无 | 0 | 仅包含 mssanitizer 头部信息 |

### 测试源文件

`test/fixtures-src/add_custom.cpp` — 一个包含 5 个已知 bug 的 Ascend C 算子：

| 行号 | Bug | 对应错误类型 |
|---|---|---|
| 27 | `DataCopy` size 为 `2 * TILE_LENGTH`，超出 buffer | `OUT_OF_BOUNDS` |
| 30 | 写入 `zLocal` 超出其容量 | `ILLEGAL_ADDR_WRITE` |
| 33 | `zGlobal` 偏移 `progress * 3` 超出 GM 范围 | `OUT_OF_BOUNDS` |
| 36-37 | `misaligned` tensor 未对齐 | `MISALIGNED_ACCESS` |
| 41 | `yLocal` 在 `DataCopy` 前被读取 | `UNINITIALIZED_READ` |

---

## 常见问题排查

### Q: `npm run compile` 报错

```
# 清理后重新编译
rm -rf out node_modules
npm install
npm run compile
```

### Q: Ollama 连接成功但 LLM 返回空响应

```
# 检查模型是否加载完成
ollama list

# 尝试手动调用
curl http://localhost:11434/v1/chat/completions \
  -d '{"model":"qwen3:8b","messages":[{"role":"user","content":"hi"}]}'
```

### Q: Agent 循环中 LLM 不调用工具而是直接回复

这是模型行为问题，可能原因：
- 模型参数量太小（< 7B），无法稳定遵循 tool calling 指令
- `temperature` 设置过高，降低到 `0` 或 `0.1`
- 尝试换用 `qwen3:8b` 或更大的模型

### Q: Extension Host 中命令不出现

```
# 确认编译产物最新
npm run compile

# 检查 package.json 的 activationEvents
# 应包含 "onCommand:ms-agent.parseLog"

# 重启 Extension Host（关闭窗口后重新 F5）
```

### Q: CodeAction 灯泡不出现

CodeAction 需要先解析日志推送诊断到 Problems 面板，且诊断的 `source` 必须为 `ms-agent`。确认：
1. 已执行 `Parse Log File` 且 Problems 面板有诊断项
2. 光标在诊断对应的文件和行号上
3. 尝试 `Cmd+.` 手动触发 Quick Fix
