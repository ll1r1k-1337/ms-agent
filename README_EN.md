# msAgent

**English** | [中文](./README.md)

**msAgent - Intelligent Memory Error Fixer for Ascend NPU Operators** — An agentic LLM-powered auto-fix tool for Ascend NPU operator memory errors.

![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)
![VSCode](https://img.shields.io/badge/VSCode-1.85+-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

msSanitizer is an Ascend NPU operator anomaly detection tool that produces text-based diagnostic logs. This VSCode extension parses these logs and uses **local LLMs** (Ollama / vLLM) with an Agent loop to automatically analyze errors and generate Ascend C operator code fixes.

---

## Features

- Parse msSanitizer \`--tool=memcheck\` logs and push diagnostics to VSCode Problems panel
- Agent loop-based intelligent fix: Read → Analyze → Generate → Apply → Verify
- CodeAction quick fix support (lightbulb icon / Cmd+.)
- Support for all 8 memory error types
- Fully local execution, no cloud API dependency
- Compatible with any OpenAI /v1/chat/completions endpoint
- **Real-time Streaming Output**: WebView displays live LLM responses including:
  - Text generation with cursor animation
  - Tool calls and parameters (read_file, edit_file)
  - Tool execution results
  - Side-by-side code diff view (green for additions, red for deletions)
  - Stop button to interrupt fix process
- **Progress Visualization**: Real-time progress notifications with cancellation support
- **Config Validation**: Automatic LLM connection check on startup

## Supported Error Types

| Error Type | Description |
|---|---|
| ILLEGAL_ADDR_READ | Illegal address read |
| ILLEGAL_ADDR_WRITE | Illegal address write |
| OUT_OF_BOUNDS | Out-of-bounds access |
| MISALIGNED_ACCESS | Misaligned access |
| MEM_LEAK | Memory leak |
| ILLEGAL_FREE | Illegal free |
| MEM_UNUSED | Unused memory |
| UNINITIALIZED_READ | Uninitialized read |

## Installation

```bash
git clone <repo-url> ms-agent
cd ms-agent
npm install
npm run compile
```

Open in VSCode and press **F5** to debug.

## Configuration

| Setting | Default | Description |
|---|---|---|
| msagent.modelEndpoint | http://localhost:11434 | LLM API endpoint |
| msagent.modelName | qwen3:8b | Model name |
| msagent.temperature | 0.1 | Generation temperature |
| msagent.maxTokens | 4096 | Max tokens per generation |
| msagent.timeoutMs | 300000 | LLM request timeout in ms (default: 5 minutes) |

## Commands & Keybindings

| Command | Description | Keybinding |
|---|---|---|
| msAgent: Parse Log File | Parse mssanitizer log | Cmd+Alt+L / Ctrl+Alt+L |
| msAgent: Fix All Issues | Batch fix all diagnostics | Cmd+Alt+F / Ctrl+Alt+F |
| msAgent: Clear Diagnostics | Clear all diagnostics | Cmd+Alt+C / Ctrl+Alt+C |
| msAgent: Open Settings | Open settings page | - |

## Quick Start

1. Run: \`mssanitizer --tool=memcheck ./your_operator 2>&1 | tee memcheck.log\`
2. Parse: Cmd+Shift+P → msAgent: Parse Log File
3. Fix: Click lightbulb icon → Fix: <error_type>

## Documentation

- [README.md](./README.md) - Chinese version
- [CHANGELOG.md](./CHANGELOG.md) - Release notes and changelog
- [docs/SOURCE_GUIDE.md](./docs/SOURCE_GUIDE.md) - Source code guide (Chinese)
- [docs/TEST_GUIDE.md](./docs/TEST_GUIDE.md) - Test guide (Chinese)

## License

MIT
