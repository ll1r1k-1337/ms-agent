# msAgent

[English](./README_EN.md) | **中文**

**msAgent** 是一个 VS Code 扩展，用于解析 `mssanitizer --tool=memcheck` 日志，并通过 **OpenCode** 自动修复 Ascend C / C++ 算子中的内存错误。

## 当前定位

- 日志解析器：把 msSanitizer 日志转换成 VS Code Problems 诊断
- Quick Fix：从 Problems 面板或灯泡菜单直接触发 `msagent.fixProblem`
- OpenCode-only 修复：修复链路统一走 OpenCode `server` 或 `acp`
- Fix Details 面板：首屏只保留状态、当前动作、结果，原始细节折叠到 `Technical details`
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
| `msagent.modelName` | `qwen3:8b` | OpenCode 使用的模型名 |
| `msagent.timeoutMs` | `300000` | 单次修复超时 |
| `msagent.opencodeMode` | `server` | 传输模式，仅支持 `server` / `acp` |
| `msagent.opencodeServePort` | `7325` | `opencode serve` 端口 |
| `msagent.opencodeCliPath` | `opencode` | OpenCode 可执行文件路径 |
| `msagent.opencodeAcpArgs` | `["acp"]` | ACP 模式启动参数 |
| `msagent.opencodeApiKey` | `""` | 可选，传给 OpenCode 的 API Key |

示例：

```json
{
  "msagent.modelName": "qwen3:8b",
  "msagent.timeoutMs": 300000,
  "msagent.opencodeMode": "server",
  "msagent.opencodeServePort": 7325,
  "msagent.opencodeCliPath": "opencode",
  "msagent.opencodeAcpArgs": ["acp"],
  "msagent.opencodeApiKey": ""
}
```

## 命令

| 命令 | 说明 |
|---|---|
| `msAgent: Parse Log File` | 解析日志并发布诊断 |
| `msAgent: Fix All Issues` | 修复当前文件中的全部 msAgent 诊断 |
| `msAgent: Clear Diagnostics` | 清空当前 msAgent 诊断 |

内部命令 `msagent.fixProblem` 由 Quick Fix 和测试链路调用。

## 使用流程

1. 运行 `mssanitizer --tool=memcheck` 生成日志。
2. 在 VS Code 中执行 `msAgent: Parse Log File`。
3. 在 Problems 面板或灯泡菜单触发单个修复，或执行 `msAgent: Fix All Issues`。
4. 在 Fix Details 面板观察当前动作和最终结果；若 OpenCode 没改文件，会直接展示原因。

## 架构概览

```text
log file
  -> parser/logParser.ts
  -> vscode/diagnosticsManager.ts
  -> vscode/codeActionProvider.ts
  -> vscode/fixService.ts
  -> backends/openCodeFixBackend.ts
  -> backends/opencodeTransport.ts (server | acp)
  -> backends/opencodeSession.ts
  -> webview/webviewPanelProvider.ts
```

当前实现不再包含：

- 宿主自定义 Agent 工具执行链
- 内置 OpenAI-compatible backend
- 独立设置 WebView
- OpenCode `cli` / `api` 传输模式

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
- [docs/OPENCODE_AGENT_INTEGRATION_PLAN.md](./docs/OPENCODE_AGENT_INTEGRATION_PLAN.md)

## License

MIT
