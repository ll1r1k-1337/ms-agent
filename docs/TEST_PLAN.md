# msAgent 测试计划

本文档描述当前仓库的测试重点，不再记录历史上的多后端、多 transport 计划。

## 目标

- 保证日志解析与诊断发布稳定
- 保证 Quick Fix 通过 `msagent.fixProblem(index)` 精确命中
- 保证本地 `opencode serve` 复用 / 自动拉起链路稳定
- 保证 SDK 驱动的 session 流程满足协议安全约束
- 保证成功修复时始终能得到统一三段式 explanation
- 保证失败与 no-op 场景不污染原文件

## 当前重点

### P1. 单元测试

- `configResolver` 只输出当前 OpenCode-only 配置
- `backendFactory` 只创建 `OpenCodeFixBackend`
- `diagnosticsManager` 精确 range 与 `msAgentIndex`
- `codeActionProvider` 走 index 路由
- `opencodeServerManager` 覆盖服务复用、拉起、失败路径
- `opencodeSdkClient` 覆盖 subscribe / create / prompt / abort / messages
- `opencodeSession` 覆盖：
  - finalize
  - cancel
  - soft close
  - disk diff confirmation
  - structured explanation
  - synthetic explanation
  - patch 成功后 follow-up `MessageAbortedError`

### P2. 集成测试

- `fixService` 队列状态和 WebView 消息一致
- `Fix Details` 面板首屏保留状态 / 当前动作 / 结果
- 成功修复时：
  - `finalMessage` 必含 `Problem:`
  - 必含 `Fix:`
  - 必含 `Why it works:`
  - `explanationKind` 只能是 `structured` 或 `synthetic`
- `no_change` 和 `failed` 终态展示正确
- 本地 server + SDK 至少跑通一条真实修复链路

### P3. 手动验收

- Problems 面板触发 Quick Fix
- 成功修复后只移除当前问题高亮
- 同文件其他问题高亮继续保留
- 成功修复首屏 explanation 始终为三段式
- 不再出现“成功但只显示 `Explanation unavailable`”的结果

## 已移出范围

以下内容已经不属于当前计划：

- OpenAI-compatible provider 测试
- 宿主工具链 `read_file` / `edit_file` / `list_files`
- 内置 agent loop 测试
- 设置面板测试
- OpenCode `cli` / `api` / `acp` 模式测试

## 推荐执行顺序

1. `npm run compile`
2. `npm test`
3. `npm run test:integration`
4. `npm run test:coverage`
5. Extension Host 手动验证本地 server 复用 / 拉起
6. Extension Host 手动验证成功修复 explanation 协议

## 通过标准

- 自动化测试全部通过
- 覆盖率命令可完成
- Quick Fix 高亮与路由行为正确
- 取消、暂停、软关闭不会导致提前成功或错误写盘
- 成功修复 explanation 必须为统一三段式
- no-op 场景必须展示 OpenCode 原因或 fallback 文案
