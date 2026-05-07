# msAgent OpenCode Integration Architecture

本文档记录当前仓库已经落地的 OpenCode 集成架构，而不是历史迁移草案。

## 当前结论

msAgent 现在是一个 **OpenCode-only** 的 VS Code 扩展，修复主路径固定为：

```text
fixService
  -> OpenCodeFixBackend
  -> OpenCodeTransport
  -> OpenCodeTurnRunner
  -> OpenCodeSdkClient
  -> local opencode serve
  -> OpenCodeSession
  -> WebView / final result
```

这条路径的产品事实是：

- 扩展会优先复用本地已有的 `opencode serve`
- 没有可复用服务时，扩展会自动拉起本地 `opencode serve`
- 运行中的 session / event / abort / messages 统一通过官方 `@opencode-ai/sdk`
- 成功修复必须输出统一三段式 explanation

## 范围外能力

当前仓库不再支持：

- 内置 OpenAI-compatible backend
- 宿主自定义 agent 工具执行链
- 独立设置 WebView
- OpenCode `cli` / `api` / `acp` 传输模式

## 分层职责

| 层 | 文件 | 职责 |
|---|---|---|
| Factory | `src/backends/backendFactory.ts` | 固定返回 `OpenCodeFixBackend` |
| Backend | `src/backends/openCodeFixBackend.ts` | 读取诊断、组 prompt、启动 transport 与 session |
| Transport | `src/backends/opencodeTransport.ts` | 暴露项目内 transport 抽象，桥接 SDK-era runner |
| Server manager | `src/backends/opencodeServerManager.ts` | 复用、拉起、探测本地 `opencode serve` |
| SDK client | `src/backends/opencodeSdkClient.ts` | 封装 session / subscribe / prompt / abort / messages |
| Turn runner | `src/backends/opencodeTurnRunner.ts` | 保证先订阅、再建 session、再发 prompt、再等硬终止 |
| Session | `src/backends/opencodeSession.ts` | 聚合事件、执行终态保护、确认磁盘改动、生成 explanation |
| Adapter | `src/backends/opencodeEventAdapter.ts` | 把 OpenCode 事件规范化为内部事件形状 |

## 成功判定与 explanation 协议

当前成功路径必须同时满足：

1. 收到协议定义的硬终止条件
2. 磁盘内容真实发生改变
3. 结果 explanation 最终可归一化为三段式

成功结果只允许两类 explanation：

- `structured`
- `synthetic`

流程优先级：

1. 直接使用 OpenCode 持久化的三段式 explanation
2. 若 session message 里存在合规 explanation，则回退到该内容
3. 若 patch 已成功应用，但 explanation 缺失或不合规，则由宿主端生成 synthetic explanation

因此，“成功修复但没有 explanation” 已经不再是产品允许的最终状态。

## 安全约束

- `session.idle`、`server.disconnect` 之类软信号不算成功
- 只有 `session.run()` settle 之后才允许释放 transport
- patch 已成功落盘但后续 explanation message 中断时，仍保留成功结果，并补 synthetic explanation
- 未确认磁盘改动时，不把工具调用或文本输出误判为 `applied`

## 维护建议

修改以下文件前，应先阅读 `opencode-protocol` skill：

- `src/backends/opencodeTransport.ts`
- `src/backends/opencodeSession.ts`
- `src/backends/opencodeEventAdapter.ts`
- `src/backends/openCodeFixBackend.ts`
- `test/fixtures/llm-scenarios/*.json`

任何影响 finalize 逻辑的变更，都应先补 fixture，再改实现。
