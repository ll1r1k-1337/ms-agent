# Release Notes - msAgent v0.1.0

**English** | [中文](#概述)

**发布日期：** 2026-04-01

## 概述

msAgent 是一款 VSCode 扩展，为昇腾 NPU 算子开发者提供基于本地大模型（LLM）的内存错误自动修复能力。本插件解析 mssanitizer 内存检测日志，利用 Agent 循环智能分析错误并生成 Ascend C 算子代码修复。

## ✨ 新功能

### 核心特性

- **日志解析** — 解析 mssanitizer `--tool=memcheck` 输出日志，推送诊断到 VSCode Problems 面板
- **智能修复** — 基于 Agent 循环的自动化修复流程：读取源文件 → 分析错误 → 生成修复 → 应用编辑 → 验证结果
- **Quick Fix 集成** — 点击灯泡图标或 `Cmd+.` 触发修复，与 VSCode 原生体验无缝集成
- **批量修复** — 一键修复当前文件的所有内存错误
- **本地运行** — 完全本地化，无需云端 API，支持 Ollama / vLLM / llama.cpp 等本地 LLM 后端

### 支持的内存错误类型

| 错误类型 | 描述 | 典型场景 |
|---|---|---|
| `OUT_OF_BOUNDS` | 越界访问 | 数组/缓冲区访问超出范围 |
| `ILLEGAL_ADDR_READ` | 非法地址读 | 读取未分配或无效的内存地址 |
| `ILLEGAL_ADDR_WRITE` | 非法地址写 | 写入未分配或无效的内存地址 |
| `MISALIGNED_ACCESS` | 未对齐访问 | 地址未按数据类型要求对齐 |
| `MEM_LEAK` | 内存泄漏 | 分配后未释放的内存 |
| `ILLEGAL_FREE` | 非法释放 | 重复释放或释放未分配内存 |
| `MEM_UNUSED` | 内存未使用 | 已分配但从未读写的内存 |
| `UNINITIALIZED_READ` | 未初始化读 | 读取未初始化的缓冲区 |

### 技术亮点

- **Agent 循环架构** — 支持多轮工具调用与验证
- **Tool Dispatch** — LLM 通过 `read_file` / `edit_file` / `list_files` / `read_diagnostics` 四个工具与文件系统交互
- **On-demand Skills** — 动态加载 Ascend C 内存修复知识库，提供领域专家级的修复建议
- **错误恢复** — 完善的错误处理机制：连接拒绝、超时、格式错误等场景均有友好提示

## 📋 系统要求

| 组件 | 最低版本 |
|---|---|
| VSCode | 1.85+ |
| Node.js | 18+ |
| Ollama（或其他本地 LLM） | 任意版本 |

### 推荐模型

| 模型 | 参数量 | 修复质量 | 显存需求 |
|---|---|---|---|
| `qwen3-coder:30b` | 30.5B | ⭐⭐⭐⭐⭐ | ~20GB |
| `qwen3:8b` | 8.2B | ⭐⭐⭐⭐ | ~6GB |
| `deepseek-coder:6.7b` | 6.7B | ⭐⭐⭐⭐ | ~5GB |
| `qwen2.5:3b` | 3.1B | ⭐⭐⭐ | ~3GB |

> **建议：** 优先使用 `qwen3:8b` 或更大参数量的模型，以获得更好的 Ascend C DSL 理解能力。

## 🚀 安装

### 方式一：从源码构建

```bash
git clone <repo-url> ms-agent
cd ms-agent
npm install
npm run compile
```

在 VSCode 中打开项目，按 **F5** 启动 Extension Host 调试。

### 方式二：VSIX 安装

```bash
npm run compile
npx vsce package
# 生成 msagent-0.1.0.vsix
```

在 VSCode 中：`Cmd+Shift+P` → `Extensions: Install from VSIX...` → 选择 `.vsix` 文件。

### 配置 LLM

```json
{
  "msagent.modelEndpoint": "http://localhost:11434",
  "msagent.modelName": "qwen3:8b",
  "msagent.temperature": 0.1,
  "msagent.maxTokens": 4096
}
```

## 🎯 快速开始

### Step 1: 运行 mssanitizer

```bash
mssanitizer --tool=memcheck ./your_operator 2>&1 | tee memcheck.log
```

### Step 2: 解析日志

`Cmd+Shift+P` → `msAgent: Parse Log File` → 选择 `memcheck.log`

### Step 3: 修复错误

- **单个修复：** 点击行号旁灯泡图标 → `Fix: <错误类型>`
- **批量修复：** `Cmd+Shift+P` → `msAgent: Fix All Issues`

## ⚠️ 已知问题

1. **文件路径解析** — 当日志中的源文件路径为相对路径时，需要在工作区根目录或日志文件所在目录下查找。当前实现支持一级子目录递归搜索，深层目录可能无法自动定位。

2. **模型稳定性** — 较小参数量的模型（< 7B）可能无法稳定遵循 tool calling 指令，建议使用 `qwen3:8b` 或更大模型。

3. **修复质量** — LLM 生成的修复建议仅供参考，请开发者审查后再应用到生产代码。

## 📚 文档

- [README.md](./README.md) — 使用指南
- [docs/SOURCE_GUIDE.md](./docs/SOURCE_GUIDE.md) — 源码架构详解
- [docs/TEST_GUIDE.md](./docs/TEST_GUIDE.md) — 测试指南

## 🔧 技术架构

```
┌─────────────────┐
│ mssanitizer log │
└────────┬────────┘
         │ parse
         ▼
┌─────────────────┐     ┌──────────────────┐
│ Log Parser      │────▶│ VSCode Problems  │
└─────────────────┘     └────────┬─────────┘
                                 │ trigger
                                 ▼
┌─────────────────┐     ┌──────────────────┐
│ Fix Service     │────▶│ Agent Loop       │
└─────────────────┘     └────────┬─────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ LLM Provider    │◀───▶│ Tool Handlers    │◀───▶│ File System     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License

---

**下一版本计划（v0.2.0）：**

- [ ] 支持 racecheck / synccheck 错误类型
- [ ] Webview 聊天面板，支持交互式修复
- [ ] 修复历史记录与回滚
- [ ] 更多 LLM 后端优化（流式输出、上下文压缩）

---

感谢使用 msAgent！如有问题，请提交 [Issue](../../issues)。