# msAgent 源码指南

[English](#source-guide-en) | **中文**

## 目录
- [整体架构](#整体架构)
- [模块详解](#模块详解)
  - [parser — 日志解析器](#parser--日志解析器)
  - [agent — Agent 循环核心](#agent--agent-循环核心)
  - [llm — LLM 通信层](#llm--llm-通信层)
  - [tools — 工具集](#tools--工具集)
  - [skills — 知识技能库](#skills--知识技能库)
  - [vscode — VSCode 集成层](#vscode--vscode-集成层)
  - [extension — 入口](#extension--入口)
- [数据流](#数据流)
- [日志格式规范](#日志格式规范)
- [错误类型与修复策略](#错误类型与修复策略)
- [测试](#测试)

---

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    extension.ts (入口)                        │
│  注册 3 个命令 + CodeActionProvider                           │
└──────┬──────────────────┬──────────────────┬────────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
  parseLog 命令      fixAll 命令       CodeAction 触发
       │                  │                  │
       ▼                  ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ diagnostics  │   │  fixService  │   │ codeAction   │
│  Manager     │   │              │   │  Provider    │
│              │   │  ┌────────┐  │   │              │
│  parseLog()  │   │  │ skill  │  │   │  ──────────► │──┐
│  ──────────► │   │  │ Loader │  │   │  fixDiagnostic│  │
│  VSCode      │   │  └────────┘  │   └──────────────┘  │
│  Problems    │   │  ┌────────┐  │                     │
│  Panel       │   │  │ agent  │  │◄────────────────────┘
└──────────────┘   │  │  Loop  │  │
                   │  └───┬────┘  │
                   │      │       │
                   │      ▼       │
                   │  ┌────────┐  │
                   │  │  LLM   │  │
                   │  │Provider│  │
                   │  └───┬────┘  │
                   │      │       │
                   │      ▼       │
                   │  ┌────────┐  │
                   │  │ Tools  │  │
                   │  └────────┘  │
                   └──────────────┘
```

**分层设计：**

| 层 | 目录 | 职责 | 依赖 |
|---|---|---|---|
| 解析层 | `parser/` | 日志文本 → 结构化诊断 | 仅 Node.js `fs`/`path` |
| Agent 层 | `agent/` | 消息管理 + 循环控制 | 无外部依赖 |
| LLM 层 | `llm/` | OpenAI 兼容 HTTP 通信 | Node.js `http`/`https` |
| 工具层 | `tools/` | 文件读写 + 诊断读取 | Node.js `fs`/`path` + `vscode` |
| 技能层 | `skills/` | Ascend C 修复知识 | Node.js `fs`/`path` |
| VSCode 层 | `vscode/` | 诊断推送 + 修复编排 | 以上所有层 |
| 入口 | `extension.ts` | 命令注册 + 生命周期 | VSCode 层 |

核心逻辑（parser、agent、llm、tools）**不依赖 VSCode API**，可独立测试。

---

## 模块详解

### parser — 日志解析器

**文件：** `parser/types.ts` + `parser/logParser.ts`

#### types.ts — 类型定义

```typescript
enum MemErrorType {
    OUT_OF_BOUNDS          // 越界访问
    ILLEGAL_ADDR_WRITE     // 非法地址写
    ILLEGAL_ADDR_READ      // 非法地址读
    MISALIGNED_ACCESS      // 未对齐访问
    MEM_LEAK               // 内存泄漏
    ILLEGAL_FREE           // 非法释放
    MEM_UNUSED             // 内存未使用
    UNINITIALIZED_READ     // 未初始化读
}

enum AddressSpace { GM, UB, L1, L0A, L0B, L0C }  // 昇腾存储层级
enum BlockType    { AICORE, AIV, AIC }            // 执行单元类型
enum Severity     { ERROR, WARNING }

interface SanitizerDiagnostic {
    errorType: MemErrorType
    severity: Severity
    fileName: string           // 出错源文件
    lineNumber: number         // 出错行号 (1-based)
    serialNo: number           // 操作序列号
    address: string            // 出错地址 (hex)
    addressSpace: AddressSpace // 出错存储空间
    byteSize: number           // 涉及字节数
    blockInfo: BlockInfo       // 执行单元信息
    deviceId: number           // 设备 ID
    kernelName?: string        // Kernel 名称
    threadLocation?: ThreadLocation  // SIMT 线程位置
    pc?: string                // 程序计数器
    callStack?: StackFrame[]   // 调用栈
    moduleId?: number          // 模块 ID (内存泄漏)
    rawLines: string[]         // 原始日志行
}

interface ParseResult {
    diagnostics: SanitizerDiagnostic[]  // 解析出的诊断
    parseErrors: string[]               // 解析失败记录
}
```

#### logParser.ts — 解析引擎

**核心流程：**

```
原始日志文本
    │
    ▼
groupLines()          ← 正则分行 + 归组
    │                   HEADER_RE:   /^====== (ERROR|WARNING): (.+)$/
    │                   DETAIL_RE:   /^======    (.+)$/
    │                   LEAK_HEADER_RE: /^======    (Direct leak|WARNING: Unused memory) (.+)$/
    ▼
parseGroup()          ← 逐组解析为 SanitizerDiagnostic
    │                   classifyError()  → 确定 MemErrorType
    │                   parseAddressSpace() → 确定 AddressSpace
    │                   parseBlockType()     → 确定 BlockType
    │                   FILELINE_RE 提取文件名:行号
    │                   STACK_RE 提取调用栈帧
    ▼
ParseResult           ← { diagnostics[], parseErrors[] }
```

**两种日志格式的处理：**

| 格式 | 正则 | 示例 |
|---|---|---|
| 标准错误 | `HEADER_RE` 匹配 `====== ERROR:` 或 `====== WARNING:` | `illegal read of size 368` |
| 泄漏/未使用 | `LEAK_HEADER_RE` 匹配 `======    Direct leak` 或 `======    WARNING: Unused memory` | `Direct leak of 32800 byte(s)` |

**防御性处理：**
- 空日志 → 直接返回空结果
- 文件不存在 → `{ diagnostics: [], parseErrors: ['File not found: ...'] }`
- 二进制行（含 `\0`）→ 自动跳过
- `JSON.parse` / `fs.readFileSync` 错误 → try-catch 降级

---

### agent — Agent 循环核心

**文件：** `agent/message.ts` + `agent/agentLoop.ts`

#### message.ts — 消息类型系统

```
Message
  ├── role: 'system' | 'user' | 'assistant' | 'tool'
  └── content: ContentBlock[]
        ├── TextContent       { type: 'text', text }
        ├── ToolCallContent   { type: 'tool_use', id, name, input }
        └── ToolResultContent { type: 'tool_result', tool_use_id, content, is_error? }
```

辅助函数：
- `textMessage(text)` → 创建 user 消息
- `assistantMessage(content)` → 创建 assistant 消息
- `toolResultMessage(id, content, isError?)` → 创建 tool 结果消息
- `extractText(msg)` / `extractToolCalls(msg)` → 消息内容提取

#### agentLoop.ts — 循环控制器

```typescript
interface AgentRunOptions {
    systemPrompt: string           // 系统提示词
    taskDescription: string        // 任务描述（作为首条 user 消息）
    toolContext: ToolContext       // 工具执行上下文
    llm: LLMProvider              // LLM 实例
    maxToolRounds?: number         // 最大工具调用轮次 (默认 20)
    abortSignal?: { aborted: boolean }  // 外部中止信号
    onToolCall?: (name, params) => void   // 工具调用回调
    onTextResponse?: (text) => void      // 文本响应回调
}
```

**循环流程：**

```
messages = [textMessage(taskDescription)]

for round in 0..maxToolRounds:
    ① 检查 abortSignal → 如果中止则提前返回
    
    ② llm.chat(messages, tools, systemPrompt)
       │
       ├─ stopReason = 'end_turn'  → 返回最终文本响应 ✅
       ├─ stopReason = 'max_tokens' → 返回（token 耗尽）
       └─ stopReason = 'tool_use'   → 继续 ↓
       
    ③ 遍历 content 中的 tool_use 块:
       for each ToolCallContent:
           result = executeTool(name, input, context)
           messages.push(toolResultMessage(id, result))
           
    ④ 消息长度保护：
       if messages.length > 100 → 裁剪最旧的非 system 消息
```

**关键设计：**
- 消息数组是**有状态的**，每次循环追加 assistant + tool_result，形成完整对话历史
- 工具执行错误不中断循环，而是作为 `is_error=true` 的 tool result 回传给 LLM，让 LLM 自行修正
- `abortSignal` 支持外部取消（如用户关闭编辑器）

---

### llm — LLM 通信层

**文件：** `llm/provider.ts` + `llm/openaiCompatProvider.ts` + `llm/config.ts`

#### provider.ts — 接口定义

```typescript
interface LLMProvider {
    chat(messages: Message[], tools: ToolDefinition[], systemPrompt?: string): Promise<LLMResponse>
}

interface LLMResponse {
    content: ContentBlock[]      // 文本 + 工具调用
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
    usage?: { promptTokens, completionTokens }
}
```

两个关键转换函数：
- `toApiTool(tools)` → 转为 OpenAI function calling 格式
- `toApiMessages(messages, systemPrompt)` → 转为 OpenAI Chat API 格式

**`toApiMessages` 的消息格式转换：**

| 内部 Message | OpenAI API 格式 |
|---|---|
| `{ role: 'user', content: [{ type: 'text' }] }` | `{ role: 'user', content: 'text' }` |
| `{ role: 'assistant', content: [{ type: 'tool_use', ... }] }` | `{ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments } }] }` |
| `{ role: 'tool', content: [{ type: 'tool_result' }] }` | `{ role: 'tool', tool_call_id, content }` |

> **注意：** 工具调用必须使用 `tool_calls` 字段而非放在 `content` 数组中，这是 OpenAI API 规范的要求。

#### openaiCompatProvider.ts — HTTP 实现

**错误体系：**

```typescript
class LLMProviderError extends Error {
    code: 'CONNECTION_REFUSED' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'HTTP_ERROR'
}
```

| 错误码 | 触发条件 |
|---|---|
| `CONNECTION_REFUSED` | LLM 服务未启动（`ECONNREFUSED`） |
| `TIMEOUT` | 请求超时（默认 120s） |
| `INVALID_RESPONSE` | JSON 解析失败 / 缺少 `choices` 字段 |
| `HTTP_ERROR` | 4xx/5xx 响应 |

**内容解析兼容性：**
- `choice.message.content` 为 `string` → 直接使用
- `choice.message.content` 为 `array` → 提取 `{ type: 'text' }` 元素（部分模型行为）
- `tool_calls[].function.arguments` JSON 解析失败 → 降级为 `{ _raw_arguments: '...' }`

#### config.ts — 配置读取

从 VSCode 设置 `msagent.*` 读取配置，提供默认值回退。

---

### tools — 工具集

**文件：** `tools/toolHandlers.ts`

LLM 通过这些工具与文件系统交互：

| 工具 | 输入 | 输出 | 用途 |
|---|---|---|---|
| `read_file` | `path`, `startLine?`, `endLine?` | 带行号的内容 | 读取源文件，理解上下文 |
| `edit_file` | `path`, `oldText`, `newText` | 编辑结果摘要 | 搜索替换，应用修复 |
| `list_files` | `directory?` | 文件列表（最多 50 个） | 发现项目文件结构 |
| `read_diagnostics` | `path?` | 诊断 JSON | 读取当前诊断详情 |

**ToolContext：**

```typescript
interface ToolContext {
    workspaceRoot: string       // 工作区根目录（路径解析基准）
    diagnostics?: unknown       // 当前诊断信息（传递给 LLM）
}
```

**路径解析规则：**
- 绝对路径 → 直接使用
- 相对路径 → `path.resolve(workspaceRoot, input)`

**edit_file 的搜索替换：**
- 使用 `String.indexOf()` 精确匹配 `oldText`
- 未找到 → 返回错误信息，LLM 会重试
- 找到多个 → 返回第一个匹配位置

---

### skills — 知识技能库

**文件：** `skills/memcheck-skills.md` + `skills/skillLoader.ts`

#### memcheck-skills.md — Ascend C 修复知识

这是一个 **Markdown 文件**，作为 system prompt 的一部分注入给 LLM。包含：

1. **昇腾内存架构** — GM / UB / L1 / L0A / L0B / L0C 的说明
2. **关键 API** — `DataCopy`, `pipe.InitBuffer`, `AllocTensor`, `pipe.Push/Pop`, `Add`, `Duplicate`
3. **内存规则** — buffer 大小匹配、DataCopy 不越界、32 字节对齐
4. **8 种错误类型的修复策略** — 每种错误的根因分析和修复方向

#### skillLoader.ts — 加载器

```typescript
loadSkill('memcheck-skills')  // → 读取 skills/memcheck-skills.md 内容

buildFixPrompt(diagnostic)    // → 构建修复任务 prompt
```

**prompt 组装顺序（在 fixService 中）：**

```
buildFixPrompt(diagnostic)     // 错误信息 + 修复指令
    +
loadSkill('memcheck-skills')   // Ascend C 内存架构 + 修复策略
    =
完整 system prompt + user message
```

---

### vscode — VSCode 集成层

#### diagnosticsManager.ts — 诊断管理

```typescript
class DiagnosticsManager {
    static activate(context)     // 创建 DiagnosticCollection
    static parseFileAndPublish(filePath)  // 解析日志文件并推送
    static parseAndPublish(logContent)    // 解析日志文本并推送
    static getDiagnosticForFile(filePath) // 按文件名检索诊断
    static clearDiagnostics()             // 清空所有诊断
}
```

**诊断推送流程：**

```
parseLogFile() → SanitizerDiagnostic[]
      │
      ▼
按 fileName 分组
      │
      ▼
转为 vscode.Diagnostic[]
  range = new Range(lineNumber-1, 0, lineNumber-1, 65535)
  severity = Error | Warning
  message = `[msAgent] OUT_OF_BOUNDS`
      │
      ▼
diagnosticCollection.set([Uri, Diagnostic[]][])
      │
      ▼
VSCode Problems 面板显示
```

#### codeActionProvider.ts — 快速修复

注册 `{ scheme: 'file' }` 的全局 CodeActionProvider。

当用户在源文件中触发 Quick Fix（灯泡 / `Cmd+.`）时：
1. 过滤 `source === 'msagent'` 的诊断
2. 生成 `vscode.CodeActionKind.QuickFix` 类型的 Action
3. 绑定到 `msagent.fixDiagnostic` 命令

#### fixService.ts — 修复编排

**完整的修复流程：**

```
fixSingleDiagnostic(diagnostic)
    │
    ├─ ① 读取 LLM 配置 (getLLMConfig)
    ├─ ② 创建 LLM Provider (OpenAICompatProvider)
    ├─ ③ 加载 Skill (memcheck-skills.md)
    ├─ ④ 构建 Prompt (buildFixPrompt + skill content)
    ├─ ⑤ 创建状态栏 (StatusBarItem)
    │
    ├─ ⑥ 运行 Agent 循环 (runAgent)
    │      ├── systemPrompt: "You are a memory error fix specialist..."
    │      ├── taskDescription: 完整修复 prompt
    │      ├── tools: read_file, edit_file, list_files, read_diagnostics
    │      ├── maxToolRounds: 10
    │      └── onToolCall: 更新状态栏文字
    │
    ├─ ⑦ 显示修复结果
    │      └── "View Details" → Output Channel 展示详情
    │
    └─ ⑧ 错误处理
           ├── LLMProviderError → 用户友好的错误消息
           │   CONNECTION_REFUSED → "Is Ollama/vLLM running?"
           │   TIMEOUT → "The model may be too slow..."
           │   INVALID_RESPONSE → "Try a different model."
           └── 其他异常 → 通用错误消息
```

**两个公开函数：**

| 函数 | 触发方式 | 行为 |
|---|---|---|
| `fixDiagnostic(uri, line)` | CodeAction / 单个修复 | 匹配行号±2 范围内最近的诊断，修复 |
| `fixAllDiagnostics(uri)` | 命令面板 / 批量修复 | 优先修复 Error 级别，无 Error 则修复第一个 Warning |

---

### extension — 入口

**文件：** `extension.ts`

注册 3 个命令 + 1 个 CodeActionProvider：

| 命令 ID | 标题 | 实现 |
|---|---|---|
| `msagent.parseLog` | msAgent: Parse Log File | 弹出文件选择器 → 解析 → 推送诊断 |
| `msagent.fixAll` | msAgent: Fix All Issues | 修复当前文件的所有诊断 |
| `msagent.fixDiagnostic` | (内部) | 由 CodeAction 调用，修复单个诊断 |

---

## 数据流

### 解析流程

```
mssanitizer --tool=memcheck ./operator
    │
    ▼  (文本输出)
memcheck.log
    │
    │  Cmd+Shift+P → "Parse Log File"
    ▼
parseLogFile(filePath)
    │  groupLines() → parseGroup() × N
    ▼
ParseResult { diagnostics: SanitizerDiagnostic[], parseErrors[] }
    │
    │  publishDiagnostics()
    ▼
vscode.DiagnosticCollection.set()
    │
    ▼
VSCode Problems Panel
```

### 修复流程

```
用户点击灯泡 "Fix: OUT_OF_BOUNDS"
    │
    ▼
fixDiagnostic(uri, lineNumber)
    │
    ├─ diagnosticsManager.getDiagnosticForFile()  → 找到诊断
    ├─ skillLoader.buildFixPrompt() + loadSkill() → 构建 prompt
    │
    ▼
runAgent()
    │
    │  Round 1: LLM → tool_use(read_file)
    ├─────────────→ executeTool() → 读取 kernel.cpp
    │  Round 2: LLM → tool_use(edit_file)
    ├─────────────→ executeTool() → 应用修复
    │  Round 3: LLM → end_turn (修复说明)
    │
    ▼
AgentResult { finalMessage, toolCallCount }
    │
    ▼
状态栏 → "Fix applied"
弹出 "View Details" → Output Channel 显示详情
源文件已被修改
```

---

## 日志格式规范

msSanitizer memcheck 输出的日志遵循以下格式：

### 标准错误格式

```
====== ERROR: <错误描述>
======    at 0x<地址> on <存储空间> [in <kernel名>] [when <操作>]
======    by thread (<x>,<y>,<z>)
======    in block <类型>(<id>) on device <dev>
======    code in [pc current 0x<pc>] (serialNo:<序号>)
======    #0 <文件>:<行>:<列>
```

### 内存泄漏格式（特殊）

```
====== SUMMARY: MemorySanitizer summary: N leak(s) found
======    Direct leak of <字节数> byte(s)
======      at 0x<地址> on <存储空间> by module <id>
======      allocated in <文件>:<行> (serialNo:<序号>)
```

### 未使用内存格式（特殊）

```
======    WARNING: Unused memory of <字节数> byte(s)
======      at 0x<地址> on <存储空间> by module <id>
```

**关键区别：** 泄漏和未使用内存没有 `====== ERROR:` 或 `====== WARNING:` 前缀行，而是以 `======    `（6 等号 + 4 空格）开头，需要独立的正则匹配。

---

## 错误类型与修复策略

| 错误类型 | 根因 | 修复方向 | 典型场景 |
|---|---|---|---|
| `ILLEGAL_ADDR_READ` | 读取超出 buffer/GM 边界 | 修正 `DataCopy` 的 size 参数 | 循环末次迭代越界 |
| `ILLEGAL_ADDR_WRITE` | 写入超出 buffer/GM 边界 | 修正目标地址范围或 size | UB 写入超容量 |
| `OUT_OF_BOUNDS` | 多核写重叠 GM 地址 | 调整各核的地址偏移 | 缺少 block 间地址划分 |
| `MISALIGNED_ACCESS` | 地址未对齐 | 对齐到 32 字节边界 | half 向量操作未对齐 |
| `MEM_LEAK` | GM 内存未释放 | 添加 `free` 或释放 tensor | 缺少配对的 free |
| `ILLEGAL_FREE` | 重复释放或释放未分配内存 | 检查 free 配对关系 | double free |
| `MEM_UNUSED` | 分配后未读写 | 移除无用分配或使用它 | 冗余 InitBuffer |
| `UNINITIALIZED_READ` | 读取未写入的 buffer | 确保 DataCopy 先于读操作 | pipe Push/Pop 顺序错 |

---

## 测试

### 测试文件结构

```
test/
├── fixtures/                          # 10 个日志 fixture
│   ├── illegal_read.log               # 非法地址读
│   ├── illegal_write.log              # 非法地址写
│   ├── out_of_bounds.log              # 越界访问
│   ├── misaligned_access.log          # 未对齐访问
│   ├── mem_leak.log                   # 内存泄漏
│   ├── illegal_free.log               # 非法释放
│   ├── unused_memory.log              # 内存未使用
│   ├── uninitialized_read.log         # 未初始化读
│   ├── mixed_errors.log               # 混合错误 (4 种)
│   └── no_errors.log                  # 无错误日志
└── fixtures-src/
    └── add_custom.cpp                 # Ascend C 测试算子（含 5 个已知 bug）
```

### 可自动化测试的部分

| 测试项 | 命令 | 验证内容 |
|---|---|---|
| 日志解析 | `parseLogFile(fixture)` | 10/10 fixture 解析正确 |
| LLM 通信 | `provider.chat(mock)` | 消息格式正确 |
| Agent 循环 | `runAgent(mockLLM)` | 工具调度 + 消息累积 |
| 工具执行 | `executeTool('read_file')` | 文件读取 / 编辑 / 列表 |
| E2E | `runAgent(real Ollama)` | 完整 read→edit 循环 |
| 错误恢复 | 断开 LLM 测试 | `LLMProviderError` 正确抛出 |

### 需要手动测试的部分

| 测试项 | 操作 |
|---|---|
| 命令面板 | `Cmd+Shift+P` → 命令是否出现 |
| 日志解析 | 选择 .log → Problems 面板是否显示 |
| CodeAction | 点击灯泡 → 修复是否触发 |
| 状态栏 | 修复过程中状态栏文字更新 |
| Output Channel | "View Details" → 详情是否展示 |

这些需要按 **F5** 启动 Extension Host 后手动验证。
