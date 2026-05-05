# msAgent 测试计划

当前测试计划已对齐 OpenCode-only 架构。

## 目标

- 保证日志解析与诊断发布稳定
- 保证 Quick Fix 通过 `msagent.fixProblem(index)` 稳定命中
- 保证 OpenCode `server` / `acp` 两种模式都能完成修复
- 保证会话不会因软关闭而提前结束
- 保证失败场景不污染原文件
- 保证 no-op 结果可解释，不再只显示 generic same-code 文案

## 当前重点

### P1. 单元测试

- `configResolver` 只输出 OpenCode-only 配置
- `backendFactory` 只创建 `OpenCodeFixBackend`
- `diagnosticsManager` 精确 range 与 `msAgentIndex`
- `codeActionProvider` 走 index 路由
- `opencodeTransport` 覆盖 `server` / `acp`
- `opencodeSession` 覆盖 finalize、cancel、soft close
- `NO_FIX_NEEDED`、`CANNOT_FIX`、无解释 no-op 全覆盖

### P2. 集成测试

- `fixService` 队列状态和 WebView 消息一致
- `Fix Details` 面板首屏只保留状态 / 当前动作 / 结果
- `Fix Details` 对 `applied / no_change / failed` 三种终态展示正确
- `server` 和 `acp` 各跑通至少一条修复链路

### P3. 手动验收

- Problems 面板触发 Quick Fix
- 不再出现 `SSE response error: aborted`
- `NO_FIX_NEEDED` 显示为中性“未修改代码”
- `CANNOT_FIX` 只在模型明确放弃时出现

## 已移出范围

以下内容已经不是当前计划的一部分：

- OpenAI-compatible provider 测试
- 宿主工具链 `read_file` / `edit_file` / `list_files`
- 内置 agent loop 测试
- 设置面板测试
- OpenCode `cli` / `api` 模式测试

## 推荐执行顺序

1. `npm run compile`
2. `npm test`
3. `npm run test:integration`
4. `npm run test:coverage`
5. Extension Host 手动验证 `server`
6. Extension Host 手动验证 `acp`

## 通过标准

- 自动化测试全部通过
- 覆盖率命令可完成
- Quick Fix 高亮与路由行为正确
- 取消、暂停、软关闭不会导致提前成功或错误写盘
- no-op 场景必须展示 OpenCode 原因或新的 fallback 文案
