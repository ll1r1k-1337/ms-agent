# msAgent

[English](./README_EN.md) | **中文**

**msAgent** 是一个 VS Code 扩展，用于解析 `mssanitizer --tool=memcheck` 日志，并通过 **OpenCode** 自动修复 Ascend C / C++ 算子中的内存错误。

## 当前定位

- 日志解析器：把 msSanitizer 日志转换成 VS Code Problems 诊断
- Quick Fix：从 Problems 面板或灯泡菜单直接触发 `msagent.fixProblem`
- OpenCode-only 修复：修复链路统一走 OpenCode `server`
- SDK 驱动：扩展会复用或自动拉起本地 `opencode serve`，再通过官方 `@opencode-ai/sdk` 发起 session / event / abort / messages
- 精简后的 Fix Details 面板：首屏聚焦状态、当前动作、结果和改动文件
- 成功修复解释强约束：成功结果始终展示 `Problem:` / `Fix:` / `Why it works:` 三段式说明
- Synthetic fallback：若 OpenCode 没有返回合规 explanation，msAgent 会基于诊断和已落地 diff 自动补齐解释
- no-op 语义：`NO_FIX_NEEDED` 会显示为“未修改代码”，`CANNOT_FIX` 会直接展示 OpenCode 原因

## 支持的错误类型

- `ILLEGAL_ADDR_READ`
- `ILLEGAL_ADDR_WRITE`
- `OUT_OF_BOUNDS`
- `MISALIGNED_ACCESS`
- `MEM_LEAK`
- `ILLEGAL_FREE`
- `MEM_UNUSED`
- `UNINITIALIZED_READ`

## 安装与运行

```bash
git clone <repo-url> ms-agent
cd ms-agent
npm install
npm run compile
```

在 VS Code 中打开项目后按 `F5` 启动 Extension Host。

## 依赖

- VS Code `>= 1.85`
- Node.js `>= 18`
- 已安装的 `opencode`

## 配置

所有配置都通过 VS Code 原生设置提供，搜索 `msagent` 即可。

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `msagent.modelName` | `opencode/minimax-m2.5-free` | OpenCode 使用的完整模型 ID；首次启动会尝试从 OpenCode 配置自动同步 |
| `msagent.timeoutMs` | `300000` | 单次修复超时 |
| `msagent.opencodeServePort` | `4096` | `opencode serve` 端口 |
| `msagent.opencodeCliPath` | `opencode` | OpenCode 可执行文件路径 |

示例：

```json
{
  "msagent.modelName": "opencode/minimax-m2.5-free",
  "msagent.timeoutMs": 300000,
  "msagent.opencodeServePort": 4096,
  "msagent.opencodeCliPath": "opencode"
}
```

## 命令

| 命令 | 说明 |
|---|---|
| `msAgent: Parse Log File` | 解析日志并发布诊断 |
| `msAgent: Fix All Issues` | 修复当前文件中的全部 msAgent 诊断 |
| `msAgent: Clear Diagnostics` | 清空当前 msAgent 诊断 |
| `msAgent: Select OpenCode Model` | 从本地 OpenCode 配置中选择模型并写回 `msagent.modelName` |
| `msAgent: Open Settings` | 打开 VS Code 原生 `msagent` 设置页 |

说明：

- VS Code 原生 setting 不支持运行时动态下拉
- `msagent.modelName` 因此保持为字符串
- 首次启动时，msAgent 会优先尝试从 OpenCode 配置文件同步模型
- 后续动态选择统一通过 `msAgent: Select OpenCode Model`

内部命令 `msagent.fixProblem` 由 Quick Fix 和测试链路调用。

## 使用流程

1. 运行 `mssanitizer --tool=memcheck` 生成日志。
2. 在 VS Code 中执行 `msAgent: Parse Log File`。
3. 在 Problems 面板或灯泡菜单触发单个修复，或执行 `msAgent: Fix All Issues`。
4. 在 Fix Details 面板观察当前动作和最终结果；若 OpenCode 没改文件，会直接展示原因。

## Fix Details 说明

成功修复时，Fix Details 面板会统一显示三段式 explanation：

- `Problem:` 说明原始问题
- `Fix:` 说明具体改动
- `Why it works:` 说明为什么该修改能解决问题

如果 OpenCode 没有在当前 session 中持久化自然语言 explanation，msAgent 会根据诊断和实际 patch 自动生成同格式的 synthetic explanation，因此成功态不再显示 `Explanation unavailable`。

## 架构概览

```text
log file
  -> parser/logParser.ts
  -> vscode/diagnosticsManager.ts
  -> vscode/codeActionProvider.ts
  -> vscode/fixService.ts
  -> backends/openCodeFixBackend.ts
  -> backends/opencodeTransport.ts
  -> backends/opencodeServerManager.ts
  -> backends/opencodeSdkClient.ts
  -> backends/opencodeTurnRunner.ts
  -> backends/opencodeSession.ts
  -> webview/webviewPanelProvider.ts
```

其中：

- `opencodeServerManager.ts`：负责探测、复用、拉起本地 `opencode serve`
- `opencodeSdkClient.ts`：封装官方 OpenCode SDK 的 session / event / abort / messages
- `opencodeTurnRunner.ts`：负责一次修复 turn 的顺序控制：先订阅事件，再建 session，再发 prompt，再等待硬终止

当前实现不再包含：

- 宿主自定义 Agent 工具执行链
- 内置 OpenAI-compatible backend
- 独立设置 WebView
- OpenCode `cli` / `api` / `acp` 传输模式

## 测试

```bash
npm run compile
npm test
npm run test:integration
npm run test:coverage
```

- `npm test`：仓库内单元/fixture 测试，不依赖本地 `opencode`
- `npm run test:integration`：真实调用本地 `opencode`，要求预先设置 `MSAGENT_LOCAL_MODEL`
- `npm run test:coverage`：覆盖率统计，不包含真实本地 `opencode` 套件

更多说明见：

- [docs/SOURCE_GUIDE.md](./docs/SOURCE_GUIDE.md)
- [docs/TEST_GUIDE.md](./docs/TEST_GUIDE.md)

## License

MIT
