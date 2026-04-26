# msAgent 测试指南

本文档描述当前的 **OpenCode-only** 测试方式。

## 快速命令

```bash
npm run compile
npm test
npm run test:integration
npm run test:coverage
```

## 自动化测试范围

### 1. 日志解析

覆盖：

- 8 种内存错误类型
- 混合日志
- 空日志
- 缺失文件
- 调用栈、行号、列号解析

关键文件：

- `src/parser/logParser.test.ts`

### 2. 配置与入口

覆盖：

- OpenCode-only 配置归一化
- 命令注册
- 路径解析
- 已删除命令不会再注册

关键文件：

- `src/llm/config.test.ts`
- `src/extension.test.ts`

### 3. Quick Fix 与诊断发布

覆盖：

- 诊断高亮从真实字符位置开始
- `msAgentIndex` 正确附加到诊断
- CodeAction 直接路由到 `msagent.fixProblem(index)`

关键文件：

- `src/vscode/diagnosticsManager.test.ts`
- `src/vscode/codeActionProvider.test.ts`

### 4. 修复编排

覆盖：

- 修复队列
- WebView 事件发送
- 状态切换
- 取消与暂停
- `no_change` 不生成 `final_diff`
- `no_change` 不触发 generic transport error 提示

关键文件：

- `src/vscode/fixService.test.ts`

### 5. OpenCode backend

覆盖：

- backendFactory 固定返回 `OpenCodeFixBackend`
- prompt 与 transport config 构造
- `NO_FIX_NEEDED` / `CANNOT_FIX` terminal marker 提示
- 运行结束后再释放 transport

关键文件：

- `src/backends/backendFactory.test.ts`
- `src/backends/openCodeFixBackend.test.ts`

### 6. OpenCode transport 与 session

覆盖：

- `server` / `acp` 双模式
- `server` 取消时先 abort 再关闭
- `session.idle` / `server.disconnect` 软关闭保护
- ACP `session/update` 到统一事件流的归一化
- 原生文件改动的最终 diff 检测
- `NO_FIX_NEEDED` -> `no_change`
- `CANNOT_FIX` -> 带原因的失败
- 无解释 no-op -> 新 fallback 文案

关键文件：

- `src/backends/opencodeTransport.test.ts`
- `src/backends/opencodeSession.test.ts`
- `src/backends/opencodeEventAdapter.test.ts`

### 7. WebView 状态

覆盖：

- 首屏状态 / 当前动作 / 结果聚合
- `no_change` / failed / applied 三种结果态
- 原始流、工具参数、diff 下沉到 `Technical details`

关键文件：

- `src/webview/sessionState.test.ts`
- `src/webview/fixDetailsScript.test.ts`
- `src/webview/webviewPanelProvider.test.ts`

## 手动验收

### M1. 解析日志

1. 启动 Extension Host
2. 执行 `msAgent: Parse Log File`
3. 选择 `test/fixtures/*.log`
4. 确认 Problems 面板出现诊断

### M2. Quick Fix 高亮

1. 打开被诊断命中的源码
2. 观察高亮起点
3. 确认不再从行首 `character = 0` 开始，而是从问题字符附近开始

### M3. 单条修复

1. 从 Problems 面板或灯泡菜单触发修复
2. 确认 Fix Details 首屏能快速看出“现在在做什么 / 最终结果是什么”
3. 确认修复结束前不会提前报 `aborted`
4. 若 OpenCode 未修改代码，确认首屏直接展示原因而不是 generic same-code 文案

### M4. 批量修复

1. 执行 `msAgent: Fix All Issues`
2. 确认队列状态随执行推进
3. 确认可暂停、继续、取消

### 本地 OpenCode 集成测试

`npm run test:integration` 会真实调用本地 `opencode`，默认要求：

- `MSAGENT_LOCAL_MODEL`
- 可执行的 `MSAGENT_LOCAL_OPENCODE_CLI_PATH`，默认 `opencode`
- `MSAGENT_LOCAL_OPENCODE_PORT`，默认 `7325`
- `MSAGENT_LOCAL_OPENCODE_MODE`，默认 `both`

该命令是 fail-fast 的：如果本地 `opencode` 或模型配置缺失，会直接失败并提示缺失项。

### M5. 双模式验证

分别验证：

- `msagent.opencodeMode = server`
- `msagent.opencodeMode = acp`

关注点：

- 都能发起修复
- 都能展示文本流和工具调用
- 失败时保留原文件

## 覆盖率目标

- parser / diagnostics / codeAction：高覆盖
- transport / session：覆盖关键生命周期分支
- WebView 状态：覆盖事件归一化与渲染状态更新

## 故障排查

### `opencode` 找不到

- 检查 `msagent.opencodeCliPath`
- 在终端中确认 `opencode --help` 可执行

### `server` 模式无法连接

- 检查 `msagent.opencodeServePort`
- 确认端口未被占用
- 查看输出面板中的 `OpenCodeBackend` 日志

### `acp` 模式无响应

- 检查 `msagent.opencodeAcpArgs`
- 确认本地 `opencode acp` 可正常启动

### Quick Fix 没有出现

- 确认诊断来源是 `msagent`
- 确认诊断对象带有 `msAgentIndex`

### 修复失败但文件被改坏

这应被视为回归。当前实现对软关闭和未完成场景做了保守保护，若复现，需要优先检查：

- `src/backends/opencodeSession.ts`
- `src/backends/opencodeTransport.ts`
