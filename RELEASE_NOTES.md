# Release Notes - msAgent v0.5.0

**English** | [中文](#概述)

**Release date:** 2026-05-06

## 概述

msAgent v0.5.0 把修复链路正式收敛成了 **OpenCode server + official SDK** 架构，并且把“修复成功后的 explanation 输出”升级成了强约束协议。

这次版本的核心目标有两个：

- 降低 OpenCode 协议维护成本
- 让成功修复的结果解释始终稳定、统一、可读

## 核心改进

### 1. SDK 驱动的 OpenCode 架构

当前修复主链路为：

```text
fixService
  -> OpenCodeFixBackend
  -> opencodeTransport
  -> opencodeTurnRunner
  -> opencodeSdkClient
  -> local opencode serve
```

这意味着：

- 扩展会复用或自动拉起本地 `opencode serve`
- Session / event / abort / message 获取统一走官方 `@opencode-ai/sdk`
- 不再依赖仓库主路径中的手写 HTTP + SSE 客户端实现

### 2. 成功修复 explanation 强约束

成功应用修复时，Fix Details 现在统一展示三段式 explanation：

- `Problem:`
- `Fix:`
- `Why it works:`

如果 OpenCode 应用了 patch，但没有在 session 中持久化自然语言 explanation，msAgent 会基于：

- 当前诊断
- 实际落地的 patch / diff
- 最终文件内容

自动生成一份 **synthetic explanation**。

这让成功态不再出现：

- `Explanation unavailable`

### 3. 更稳的成功判定

v0.5.0 继续保持保守的协议安全语义：

- `session.idle`、`server.disconnect` 这类软关闭不算成功
- 只有确认磁盘真的发生改动，才算 `applied`
- transport 只会在 `session.run()` 完整 settle 后释放

同时补上了一个重要边界：

- 如果 patch 已经成功落盘，但后续 assistant explanation message 因 `MessageAbortedError` 中断，结果仍会保持成功，并补上 synthetic explanation

### 4. 更好的修复体验

Fix Details 面板和修复流程的体验也同步收紧了：

- 连接阶段更聚焦 `Starting OpenCode` / `Connecting to OpenCode`
- 运行阶段更聚焦 `Repairing`
- 结束阶段更聚焦 `Verifying changes`
- 成功修复只移除当前问题高亮，不会把同文件其他问题一起清掉

## 测试与验证

这次版本重点补了以下回归覆盖：

- applied patch + no assistant explanation
- applied patch + aborted follow-up assistant message
- successful fix preserves other diagnostics in the same file
- UI renders `structured` and `synthetic` explanations consistently

推荐验证命令：

```bash
npm run compile
npm test
npm run test:integration
npm run test:coverage
```

## 升级提醒

当前版本的对外事实是：

- msAgent 是 **OpenCode-only**
- 修复路径是 **local `opencode serve` + official SDK**
- 成功修复 explanation 必须为三段式

如果你看到成功修复后仍出现 `Explanation unavailable`，应优先视为回归。
