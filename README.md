# msAgent

[English](./README_EN.md) | **中文**

**msAgent - 昇腾 NPU 算子内存错误智能修复插件** — 基于 Agentic LLM 的昇腾 NPU 算子内存错误自动修复工具

![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)
![VSCode](https://img.shields.io/badge/VSCode-1.85+-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

msSanitizer 是昇腾 NPU 算子异常检测工具，运行后会产生文本格式的诊断日志。本插件解析这些日志，利用**本地大模型**（Ollama / vLLM）以 Agent 循环的方式自动分析错误并生成 Ascend C 算子代码修复。

---

## 功能特性

- 解析 msSanitizer `--tool=memcheck` 日志，推送诊断到 VSCode Problems 面板
- 基于 Agent 循环的智能修复：`读取文件 → 分析错误 → 生成修复 → 应用编辑 → 循环验证`
- 支持 CodeAction 快速修复（灯泡图标 / `Cmd+.`）
- 支持全部 8 种内存错误类型
- 完全本地运行，不依赖任何云端 API
- 兼容任何 OpenAI `/v1/chat/completions` 接口的 LLM 后端
- **实时流式输出**：修复过程通过 WebView 实时显示 LLM 输出，包括：
  - 文本生成过程（带光标动画）
  - 工具调用及参数（read_file、edit_file）
  - 工具执行结果
  - 代码对比视图（新增行标绿，删除行标红）
  - 支持停止按钮中断修复流程
- **进度可视化**：修复过程以通知形式实时显示，支持取消操作
- **配置验证**：启动时自动检测 LLM 连接，配置错误时友好提示

## 支持的错误类型

| 错误类型 | 说明 |
|---|---|
| `ILLEGAL_ADDR_READ` | 非法地址读 |
| `ILLEGAL_ADDR_WRITE` | 非法地址写 |
| `OUT_OF_BOUNDS` | 越界访问 |
| `MISALIGNED_ACCESS` | 未对齐访问 |
| `MEM_LEAK` | 内存泄漏 |
| `ILLEGAL_FREE` | 非法释放 |
| `MEM_UNUSED` | 内存未使用 |
| `UNINITIALIZED_READ` | 未初始化读 |

## 工作流程

```
mssanitizer 运行算子
        │
        ▼
  产生诊断日志 (.log)
        │
        ▼
┌───────────────────┐
│  ms-agent │
│                   │
│  1. 解析日志       │
│  2. 推送诊断到     │──▶ VSCode Problems 面板
│     Problems 面板  │
│  3. 用户触发修复    │
│     (灯泡/命令)    │
│  4. Agent 循环:    │
│     read_file      │──▶ 读取源文件
│     └─▶ LLM 分析   │──▶ 理解错误上下文
│     └─▶ edit_file  │──▶ 应用代码修复
│     └─▶ 循环直到   │──▶ 验证修复完成
│        完成        │
└───────────────────┘
```

---

## 安装

### 前置条件

- VSCode >= 1.85
- Node.js >= 18
- Ollama 或其他本地 LLM 服务

### 方式一：从源码构建（推荐）

```bash
git clone <repo-url> ms-agent
cd ms-agent
npm install
npm run compile
```

在 VSCode 中打开项目，按 **F5** 启动 Extension Host 调试。

### 方式二：VSIX 安装

1. 构建产物：`npm run compile && npx vsce package`
2. VSCode 中 `Cmd+Shift+P` → `Extensions: Install from VSIX...`
3. 选择生成的 `.vsix` 文件

### 安装 Ollama

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.ai/install.sh | sh

# 启动服务
ollama serve

# 验证运行
curl http://localhost:11434/api/tags
```

### 拉取推荐模型

```bash
# 首选（代码能力强）
ollama pull qwen3-coder:30b

# 备选（速度快、资源占用低）
ollama pull qwen3:8b

# 轻量备选
ollama pull qwen2.5:3b
```

---

## 配置

在 VSCode 设置中搜索 `msagent`：

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `msagent.modelEndpoint` | `http://localhost:11434` | LLM API 地址（Ollama 默认端口） |
| `msagent.modelName` | `qwen3:8b` | 模型名称（需与 `ollama list` 一致） |
| `msagent.temperature` | `0.1` | 生成温度，越低越确定性 |
| `msagent.maxTokens` | `4096` | 单次生成的最大 token 数 |
| `msagent.timeoutMs` | `300000` | LLM 请求超时时间（毫秒，默认 5 分钟） |

**配置示例（JSON）：**

```json
{
  "msagent.modelEndpoint": "http://localhost:11434",
  "msagent.modelName": "qwen3:8b",
  "msagent.temperature": 0.1,
  "msagent.maxTokens": 4096,
  "msagent.timeoutMs": 300000
}
```

> **提示**：如果遇到超时错误，可以在设置中增加 `timeoutMs` 值（如 600000ms = 10 分钟），或使用较小的模型（`qwen3:8b` 而非 `30b`）。

---

## 命令与快捷键

### 可用命令

| 命令 | 说明 | 快捷键 |
|---|---|---|
| `msAgent: Parse Log File` | 解析 mssanitizer 日志文件 | `Cmd+Alt+L` (macOS) / `Ctrl+Alt+L` (Windows/Linux) |
| `msAgent: Fix All Issues` | 批量修复当前文件所有诊断 | `Cmd+Alt+F` (macOS) / `Ctrl+Alt+F` (Windows/Linux) |
| `msAgent: Clear Diagnostics` | 清除所有 msAgent 诊断 | `Cmd+Alt+C` (macOS) / `Ctrl+Alt+C` (Windows/Linux) |
| `msAgent: Open Settings` | 打开 msAgent 设置页面 | - |

### 进度显示

修复过程中，系统会实时显示进度信息：

**WebView 输出面板**（自动打开）：
- LLM 文本生成过程（实时流式输出）
- 工具调用详情（参数 + 执行结果）
- 代码对比视图（Side-by-side diff）
- **停止按钮**：点击可中断 LLM 调用

**VSCode 通知**（右下角）：
- 当前操作类型（如 `read_file(path)` 或 `edit_file(oldText, newText)`）
- 批量修复进度（如 `Fixing OUT_OF_BOUNDS (1/3)`）
- **取消按钮**：点击可中断 LLM 调用

---

## 使用方法

### Step 1: 运行 mssanitizer 生成日志

```bash
# 在昇腾设备上运行你的算子，通过 msSanitizer 检测
mssanitizer --tool=memcheck ./your_operator
# 输出日志保存到文件
mssanitizer --tool=memcheck ./your_operator 2>&1 | tee memcheck.log
```

### Step 2: 在 VSCode 中解析日志

1. 打开你的算子项目
2. `Cmd+Shift+P` → **msAgent: Parse Log File**
3. 选择 mssanitizer 生成的 `.log` 文件
4. Problems 面板（`Cmd+Shift+M`）会显示解析出的内存错误

### Step 3: 修复错误

**方式 A：快速修复（单个错误）**

- 在源文件中点击报错行的 **灯泡图标**，选择 `Fix: <错误类型>`
- 或 `Cmd+.` 打开 Quick Fix 菜单

**方式 B：批量修复**

- `Cmd+Shift+P` → **msAgent: Fix All Issues**

**方式 C：命令行修复（单个诊断）**

- 右键 Problems 面板中的诊断项，选择 `Fix: <错误类型>`

### Step 4: 验证修复

重新运行 mssanitizer，确认错误已消除。

---

## 推荐模型

| 模型 | 参数量 | 修复质量 | 速度 | 显存需求 |
|---|---|---|---|---|
| `qwen3-coder:30b` | 30.5B | 最好 | 较慢 | ~20GB |
| `qwen3:8b` | 8.2B | 良好 | 快 | ~6GB |
| `qwen2.5:3b` | 3.1B | 基础 | 最快 | ~3GB |
| `deepseek-coder:6.7b` | 6.7B | 良好 | 快 | ~5GB |

> 8B 以上参数量的模型对 Ascend C DSL 的理解明显更好，建议优先使用 `qwen3:8b` 或更大模型。

## 支持的 LLM 后端

本插件兼容任何实现 [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat) 的服务：

| 后端 | 配置示例 |
|---|---|
| [Ollama](https://ollama.ai) | `http://localhost:11434` |
| [vLLM](https://github.com/vllm-project/vllm) | `http://localhost:8000` |
| [llama.cpp server](https://github.com/ggerganov/llama.cpp) | `http://localhost:8080` |
| [xinference](https://github.com/xorbitsai/inference) | `http://localhost:9997` |

---

## 项目结构

```
src/
├── extension.ts                  # 插件入口，注册命令和 CodeAction
├── parser/
│   ├── types.ts                  # 8 种内存错误类型定义
│   └── logParser.ts              # 日志解析器（正则匹配）
├── agent/
│   ├── agentLoop.ts              # Agent 循环核心（LLM ↔ Tool 交互）
│   └── message.ts                # 消息类型定义
├── llm/
│   ├── provider.ts               # LLM Provider 接口
│   ├── openaiCompatProvider.ts   # OpenAI 兼容 HTTP 实现
│   └── config.ts                 # VSCode 设置读取
├── tools/
│   └── toolHandlers.ts           # 4 个工具：read_file, edit_file, list_files, read_diagnostics
├── skills/
│   ├── memcheck-skills.md        # Ascend C 内存错误修复知识
│   └── skillLoader.ts            # 技能加载器
└── vscode/
    ├── diagnosticsManager.ts     # 诊断管理（日志 → Problems 面板）
    ├── codeActionProvider.ts     # CodeAction 快速修复
    └── fixService.ts             # 修复编排服务
```

---

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 监听模式（开发时使用）
npm run watch

# 调试
# 在 VSCode 中按 F5 启动 Extension Host

# 代码检查
npm run lint
```

### 运行测试

```bash
# 编译后验证日志解析器
node -e "
const { parseLogFile } = require('./out/parser/logParser');
const r = parseLogFile('./test/fixtures/out_of_bounds.log');
console.log(r);
"

# E2E 测试（需要 Ollama 运行中）
node -e "
const { OpenAICompatProvider } = require('./out/llm/openaiCompatProvider');
const { runAgent } = require('./out/agent/agentLoop');
(async () => {
  const llm = new OpenAICompatProvider({
    endpoint: 'http://localhost:11434',
    modelName: 'qwen3:8b',
  });
  const r = await runAgent({
    systemPrompt: 'You are a code fixer.',
    taskDescription: 'Read /tmp/test.txt and describe its contents.',
    toolContext: { workspaceRoot: '/tmp' },
    llm,
    maxToolRounds: 3,
  });
  console.log('Tool calls:', r.toolCallCount);
  console.log('Result:', r.finalMessage);
})().catch(e => console.error(e));
"
```

---

## 技术设计

1. **Tool Dispatch** — Agent 不直接修改代码，而是通过 `read_file` / `edit_file` 工具间接操作
2. **On-demand Skills** — 动态加载 Ascend C 内存错误修复知识库
3. **Loop until done** — Agent 持续循环直到生成修复或达到轮次上限
4. **Error Recovery** — LLM 返回格式错误、连接失败等场景均有优雅降级处理

---

## License

MIT
