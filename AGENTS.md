# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

msAgent is a VSCode extension for intelligent memory error repair of Ascend NPU operators based on mssanitizer. It uses local LLMs via Ollama or OpenAI-compatible APIs to automatically analyze and fix memory errors in Ascend C kernel code.

## Build, Lint & Test Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run compile` | Compile TypeScript to JavaScript |
| `npm run watch` | Watch mode (recompile on changes) |
| `npm run lint` | ESLint check |

## Key Configuration

The extension contributes these VSCode settings:
- `msagent.modelEndpoint` - LLM API endpoint (default: `http://localhost:11434`)
- `msagent.modelName` - Model name (default: `qwen3:8b`)
- `msagent.temperature` - Sampling temperature (default: `0.1`)
- `msagent.maxTokens` - Max tokens per response (default: `4096`)
- `msagent.timeoutMs` - Request timeout in milliseconds (default: `300000`)

## Source Code Architecture

```
src/
├── extension.ts                    # Extension entry point, command registration
├── parser/
│   ├── types.ts                    # 8 memory error type definitions
│   └── logParser.ts                # mssanitizer log parser (regex-based)
├── agent/
│   ├── agentLoop.ts                # Agent loop core (LLM ↔ Tool interaction)
│   └── message.ts                  # Message type definitions
├── llm/
│   ├── provider.ts                 # LLM Provider interface
│   ├── openaiCompatProvider.ts     # OpenAI-compatible HTTP implementation
│   ├── config.ts                   # VSCode settings reader
│   └── types.ts                    # Streaming and tool call types
├── tools/
│   └── toolHandlers.ts             # Tool implementations: read_file, edit_file, list_files, read_diagnostics
├── skills/
│   ├── memcheck-skills.md          # Ascend C memory error repair knowledge base
│   └── skillLoader.ts              # Skill loading and prompt building
├── vscode/
│   ├── diagnosticsManager.ts       # Diagnostics management (log → Problems panel)
│   ├── codeActionProvider.ts       # CodeAction quick fix provider
│   └── fixService.ts               # Fix orchestration and WebView management
└── webview/
    ├── messages.ts                 # WebView ↔ Extension message definitions
    └── webviewPanelProvider.ts     # WebView panel lifecycle and messaging
```

## Supported Memory Error Types

1. **OUT_OF_BOUNDS** - Buffer overflow/underflow
2. **ILLEGAL_ADDR_READ** - Read from invalid memory
3. **ILLEGAL_ADDR_WRITE** - Write to invalid memory
4. **MISALIGNED_ACCESS** - Unaligned memory access
5. **MEM_LEAK** - Memory not freed
6. **ILLEGAL_FREE** - Invalid free operation
7. **MEM_UNUSED** - Allocated but never used
8. **UNINITIALIZED_READ** - Read from uninitialized memory

## Test Files

Test fixtures are located in `test/` with various log files for each error type. The test guide at `docs/TEST_GUIDE.md` documents test cases T1-T6.

## Important Notes

- The extension activates on opening C++ files or running any `msagent.*` command
- LLM configuration is validated on startup with a ping test
- The agent loop uses a streaming WebView to show real-time LLM reasoning
- No Cursor/Copilot rules exist - follow existing TypeScript/VSCode extension patterns
