# Release Notes - msAgent v0.2.0

**English** | [中文](#概述)

**发布日期：** 2026-04-01

## 概述

msAgent v0.2.0 带来了革命性的 **实时流式 WebView 输出面板**，让开发者能够全程观察 LLM 的推理过程、工具调用和代码修改，大幅提升了修复过程的透明度和可控性。

---

## ✨ 核心改进：实时流式 WebView

### 1. 实时文本流输出

修复过程中，WebView 面板会自动打开并实时显示 LLM 的生成内容：

- **逐字流式渲染** — 文本内容逐字出现，配合光标动画效果，完整呈现 LLM 的思考过程
- **完整输出捕获** — 包括 LLM 的分析推理、错误诊断思路和修复策略描述
- **自动滚动跟随** — 内容更新时自动滚动到最新位置，无需手动操作

**技术实现：**
- 使用 AsyncGenerator 模式解析 SSE (Server-Sent Events) 流
- 支持 Ollama、vLLM 等所有 OpenAI-compatible 后端的流式输出
- 兼容 qwen3 系列模型的 `reasoning` 字段（思考过程）

---

### 2. 工具调用可视化

Agent 循环中的每个工具调用都会在 WebView 中清晰展示：

#### 工具调用卡片
```
🔧 Tool Call: read_file
   Parameters:
   - path: "/workspace/operator/add_custom.cpp"
   
   Result:
   ✓ File loaded (152 lines)
```

#### 支持的工具类型
- `read_file` — 读取源文件内容，显示文件路径和行数
- `edit_file` — 应用代码修改，显示旧文本和新文本对比
- `list_files` — 列出工作区文件，显示文件树结构
- `read_diagnostics` — 获取诊断信息，显示错误详情

**交互体验：**
- 工具调用以独立区块显示，带有图标标识
- 参数以格式化 JSON 展示，易于阅读
- 执行结果实时显示，成功/失败状态清晰
- 工具调用计数实时更新（如 "Tool Calls: 3/10"）

---

### 3. 代码对比视图（Side-by-Side Diff）

当 Agent 调用 `edit_file` 工具修改代码时，WebView 会渲染专业的 diff 视图：

```
┌─────────────────────────────────────────────────┐
│  Original Code (Left)  │  Modified Code (Right) │
├─────────────────────────────────────────────────┤
│   int data[10];        │   int data[11];  [+1] │ ← 绿色高亮
│   for(int i=0; i<10;   │   for(int i=0; i<11;  │ ← 绿色高亮
│       i++) {           │       i++) {           │
│       data[i] = 0;     │       data[i] = 0;     │
│   }                    │   }                    │
│   free(ptr);  [-]      │                        │ ← 红色删除线
└─────────────────────────────────────────────────┘
```

**视觉设计：**
- ✅ **新增行** — 绿色背景高亮，显示新增内容
- ❌ **删除行** — 红色背景标记，显示被移除的代码
- 📝 **修改行** — 黄色背景，显示变更前后对比
- 行号清晰标注，便于定位

**实现技术：**
- 使用 diff2html 渲染引擎（CDN 加载）
- highlight.js 提供语法高亮
- 支持 C/C++ 语法识别

---

### 4. 停止按钮与取消控制

WebView 提供实时的修复流程控制：

- **⏸ Stop Button** — 顶部工具栏的停止按钮，点击即可中断当前 LLM 生成
- **即时取消** — 停止信号传递到 Agent 循环，立即终止后续工具调用
- **状态反馈** — 点击后显示 "Fix stopped by user" 提示

**底层机制：**
- CancellationToken 跨组件传递
- AbortSignal getter 模式确保实时响应
- 所有 LLM HTTP 请求支持中断

---

### 5. 安全 CSP 机制

WebView 严格遵循 VSCode 安全规范：

- **Content Security Policy** — 使用 `webview.cspSource` 和 nonce 机制
- **无外部依赖** — 所有资源通过 VSCode API 加载，不依赖外部 CDN
- **只读交互** — 禁止用户输入，仅作为输出展示窗口
- **右键菜单限制** — WebView 内禁用右键菜单（VSCode 默认行为）

**CSP 配置示例：**
```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'none'; 
               style-src ${webview.cspSource} 'unsafe-inline'; 
               script-src 'nonce-${nonce}';">
```

---

## 🔧 技术架构升级

### 新增组件

| 文件 | 功能 |
|---|---|
| `src/webview/webviewPanelProvider.ts` | WebView 面板生命周期管理 |
| `src/webview/messages.ts` | WebView ↔ Extension 消息协议定义 |
| `src/llm/types.ts` | Streaming 类型定义（StreamChunk, StreamingLLMProvider） |

### 消息协议

WebView 与 Extension 通过 JSON 消息通信：

```typescript
// Extension → WebView
{ type: 'text_chunk', content: 'string' }
{ type: 'tool_use_start', toolCall: { id, name, input } }
{ type: 'tool_result', toolCallId: 'string', result: 'string' }
{ type: 'diff', oldText: 'string', newText: 'string', filePath: 'string' }
{ type: 'finish', message: 'string' }

// WebView → Extension
{ type: 'stop_fix' }
```

---

## 📊 性能优化

- **零额外依赖** — 使用原生 JavaScript AsyncGenerator，无需第三方流式库
- **轻量渲染** — HTML 内联 CSS，避免额外网络请求
- **内存友好** — 流式处理避免大文本缓存，实时清理已渲染内容

---

## 🎯 使用体验

### 工作流程演示

1. **触发修复** — 点击灯泡图标或运行 `msAgent: Fix All Issues`
2. **WebView 自动打开** — 侧边栏显示 "msAgent: Fix Details" 面板
3. **观察 LLM 推理** — 文本流式出现，显示错误分析过程
4. **查看工具调用** — 每次 read_file/edit_file 都清晰展示
5. **审查代码变更** — diff 视图显示修改前后对比
6. **随时停止** — 发现问题时点击 Stop 按钮中断

---

## 🐛 Bug 修复

本次版本修复了以下 WebView 相关问题：

1. ✅ **WebView 白屏问题** — CSP 配置错误导致外部 CDN 资源被阻止，已修复为完全本地化
2. ✅ **Ollama 流式解析错误** — tool_calls 参数格式差异（对象 vs 字符串），现已兼容处理
3. ✅ **取消按钮无效** — AbortSignal snapshot 模式导致取消信号不更新，已改为 getter 模式
4. ✅ **diff 视图缺失** — edit_file 工具调用未触发 diff 显示，现已集成完整 diff 流程
5. ✅ **工具调用 ID 缺失** — Ollama 返回的 tool_calls 无 ID 字段，已添加自动生成逻辑

---

## 📚 文档更新

- ✅ [README.md](./README.md) — 添加 WebView 功能说明和使用截图
- ✅ [README_EN.md](./README_EN.md) — 英文版同步更新
- ✅ [CHANGELOG.md](./CHANGELOG.md) — 详细版本历史记录
- ✅ [SPEC.md](./SPEC.md) — 技术规范文档（新增）

---

## 🔮 下一版本计划（v0.3.0）

- [ ] 本地语法高亮（下载 highlight.js 到本地，避免 CDN）
- [ ] 本地 diff 渲染（下载 diff2html 到本地）
- [ ] TreeView 诊断浏览器（按错误类型分组）
- [ ] 修复历史记录与回滚功能
- [ ] 多文件同时修复支持
- [ ] 配置向导（首次使用引导）

---

## 📦 安装升级

### 从源码构建

```bash
git pull origin main
npm install
npm run compile
```

### VSIX 安装

```bash
npm run compile
npx vsce package
# 生成 msagent-0.2.0.vsix
```

---

## 🤝 反馈与贡献

遇到问题或有改进建议？欢迎提交 [Issue](../../issues) 或 [Pull Request](../../pulls)！

---

感谢使用 msAgent v0.2.0！🎉