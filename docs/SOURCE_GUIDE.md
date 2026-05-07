# msAgent 源码指南

本文档描述当前代码，而不是历史方案。当前版本已经收敛为 **OpenCode-only**。

## 模块总览

```text
src/
├── extension.ts                  # 插件入口，注册命令与生命周期
├── parser/
│   ├── types.ts                  # 诊断类型定义
│   └── logParser.ts              # mssanitizer 日志解析
├── llm/
│   ├── config.ts                 # VS Code 配置读取
│   ├── configResolver.ts         # OpenCode-only 配置归一化
│   └── types.ts                  # 流式消息类型
├── backends/
│   ├── fixBackend.ts             # 修复后端接口
│   ├── backendFactory.ts         # 固定返回 OpenCodeFixBackend
│   ├── openCodeFixBackend.ts     # 修复入口与 prompt 组装
│   ├── opencodeTransport.ts      # 上层 transport 适配层
│   ├── opencodeServerManager.ts  # 本地 opencode serve 生命周期
│   ├── opencodeSdkClient.ts      # 官方 SDK 封装
│   ├── opencodeTurnRunner.ts     # 单次修复 turn 编排
│   ├── opencodeSession.ts        # 会话状态收敛、终态保护、diff 生成
│   └── opencodeEventAdapter.ts   # 事件归一化
├── skills/
│   ├── memcheck-skills.md        # Ascend C 内存错误修复知识
│   ├── msagent-patterns.md       # 仓库结构与约定
│   └── skillLoader.ts            # 组装诊断 prompt
├── vscode/
│   ├── diagnosticsManager.ts     # 诊断发布与索引管理
│   ├── codeActionProvider.ts     # Quick Fix 入口
│   └── fixService.ts             # 队列、WebView、修复编排
└── webview/
    ├── messages.ts               # WebView 消息协议
    ├── sessionState.ts           # Fix Details 状态模型
    ├── fixDetailsScript.ts       # WebView 前端逻辑
    └── webviewPanelProvider.ts   # 面板生命周期
```

## 已删除的历史能力

当前仓库不再包含以下运行时架构：

- 宿主自定义工具执行器 `src/tools/toolHandlers.ts`
- 内置 Agent 循环 `src/agent/*`
- OpenAI-compatible backend 与 provider
- 设置 WebView 面板
- OpenCode `cli` / `api` 模式

## 核心数据流

### 1. 日志到诊断

```text
log file
  -> parseLog / parseLogFile
  -> SanitizerDiagnostic[]
  -> DiagnosticsManager.publishDiagnostics()
  -> Problems 面板
```

`DiagnosticsManager` 会为每条诊断附加稳定的 `msAgentIndex`，供 Quick Fix 和测试链路直接引用。

### 2. Quick Fix 到单条修复

```text
CodeActionProvider
  -> 读取 diagnostic.msAgentIndex
  -> executeCommand('msagent.fixProblem', index)
  -> fixService.fixProblem(index)
```

这里不再使用“按文件 + 行号模糊匹配”的旧路径。

### 3. 修复执行链

```text
fixService
  -> createFixBackend()
  -> OpenCodeFixBackend
  -> createTransport()
  -> OpenCodeTurnRunner
  -> OpenCodeSdkClient
  -> OpenCodeSession.run()
  -> WebView event stream + final diff
```

## 关键实现说明

### diagnosticsManager.ts

- 优先使用调用栈中的列号构造 `Range`
- 无列号时回退到源码行第一个非空白字符
- 诊断对象挂载 `msAgentIndex`
- 负责清空与重建 Problems 面板内容

### codeActionProvider.ts

- 只为 msAgent 诊断提供 Quick Fix
- 直接使用 `msagent.fixProblem(index)`
- 高亮范围来自诊断自身，不再从 `character = 0` 开始

### fixService.ts

- 管理修复队列、暂停、恢复、取消
- 统一向 Fix Details 面板发送：
  - `backend_info`
  - `text_stream`
  - `tool_call`
  - `tool_result`
  - `diff`
  - `final_diff`
  - `queue_state`
  - `error`
- 用户打开设置时，直接跳转 VS Code 原生设置页

### openCodeFixBackend.ts

- 读取目标文件与诊断
- 组装修复 prompt
- 固定使用 OpenCode backend
- 在 `session.run()` settle 之后才释放 transport

### opencodeTransport.ts

- 保留项目内 transport 抽象
- 不再手写 HTTP + SSE 主流程
- 把 session 回调接口接到 SDK-based runner

### opencodeServerManager.ts

- 探测端口上是否已有 `opencode serve`
- 负责复用已有服务或自动拉起本地服务
- 管理 CLI 启动失败、ready probe、共享进程表

### opencodeSdkClient.ts

- 使用官方 `@opencode-ai/sdk`
- 统一封装 event subscribe、session create、prompt、abort、messages
- 保留 SDK/CJS 互操作的懒加载处理，避免把仓库其它代码都拖进 ESM 改造

### opencodeTurnRunner.ts

- 强制执行 turn 顺序：先订阅事件，再建 session，再发 prompt
- 只向 `OpenCodeSession` 暴露当前 session 的事件
- 继续区分软关闭与硬终止
- 取消时先调用 SDK abort，再走 grace period 收尾

### opencodeSession.ts

- 负责处理 transport 事件
- 不再执行宿主侧工具
- 在最终完成前不提前 dispose
- 对软关闭场景保守处理，避免“未完成但已写盘”
- 成功修复时强制产出统一三段式 explanation：`Problem:` / `Fix:` / `Why it works:`
- 若 OpenCode 只留下工具调用或非结构化说明，会基于诊断和最终 diff 生成 synthetic explanation

## 配置来源

统一来自 `workspace.getConfiguration('msagent')`，当前保留字段：

- `modelName`
- `timeoutMs`
- `opencodeServePort`
- `opencodeCliPath`

其中模型配置的当前约定是：

- 默认值为 `opencode/minimax-m2.5-free`
- 首次激活会优先尝试从 OpenCode 配置文件同步模型
- 设置项保持字符串，不做运行时动态下拉
- 动态候选统一走 `msAgent: Select OpenCode Model`

## Explanation 流程

成功修复的 explanation 现在有明确优先级：

1. 优先使用 OpenCode 返回的三段式 explanation
2. 若 session messages 中存在合规 explanation，则回退到该内容
3. 若只有 patch/diff，没有合规 explanation，则生成 synthetic explanation

对 UI 来说，`applied` 终态只应该看到两类 explanation：

- `structured`
- `synthetic`

`missing` 只允许停留在内部诊断或日志中，不再直接展示为成功态结果。

## 命令入口

对外主命令：

- `msagent.parseLog`
- `msagent.fixProblem`
- `msagent.fixAll`
- `msagent.clearDiagnostics`

内部测试和调试还会使用：

- `msagent.getAiFixQueueStates`
- `msagent.getAiFixQueueSnapshot`
- `msagent.showFixDetails`

## 测试文件分布

- 单元测试与源码同目录放置：`src/**/*.test.ts`
- fixtures：
  - `test/fixtures/*.log`
  - `test/fixtures-src/*.cpp`
  - `test/fixtures/llm-scenarios/*.json`

## 读源码建议

推荐顺序：

1. `src/extension.ts`
2. `src/vscode/fixService.ts`
3. `src/backends/openCodeFixBackend.ts`
4. `src/backends/opencodeTransport.ts`
5. `src/backends/opencodeSession.ts`
6. `src/vscode/diagnosticsManager.ts`
7. `src/vscode/codeActionProvider.ts`
