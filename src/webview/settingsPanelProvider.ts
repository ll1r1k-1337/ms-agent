import * as vscode from 'vscode';
import { WebviewMessage } from './messages';

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export class SettingsPanelProvider {
    private panel: vscode.WebviewPanel | undefined;

    createOrShow(context: vscode.ExtensionContext, initialConfig: Record<string, unknown>): vscode.WebviewPanel {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            this.panel.webview.postMessage({
                type: 'settings_init',
                payload: initialConfig,
            });
            return this.panel;
        }

        this.panel = vscode.window.createWebviewPanel(
            'msAgentSettings',
            'msAgent 设置',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        this.panel.webview.html = this.getHTML(this.panel.webview);

        this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
            this.handleMessage(message, context);
        });

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });

        this.panel.webview.postMessage({
            type: 'settings_init',
            payload: initialConfig,
        });

        return this.panel;
    }

    private handleMessage(message: WebviewMessage, context: vscode.ExtensionContext): void {
        switch (message.type) {
            case 'settings_save': {
                const settings = message.payload as Record<string, unknown>;
                this.saveSettings(settings).then(() => {
                    this.panel?.webview.postMessage({
                        type: 'settings_test_result',
                        payload: { success: true, message: '设置已保存' },
                    });
                }).catch((err) => {
                    this.panel?.webview.postMessage({
                        type: 'settings_test_result',
                        payload: { success: false, message: `保存失败: ${err.message}` },
                    });
                });
                break;
            }
            case 'settings_test_connection': {
                const settings = message.payload as Record<string, unknown>;
                this.testConnection(settings).then((result) => {
                    this.panel?.webview.postMessage({
                        type: 'settings_test_result',
                        payload: result,
                    });
                });
                break;
            }
            case 'settings_reset': {
                this.resetSettings().then(() => {
                    const defaults = {
                        agentMode: 'builtin',
                        modelEndpoint: 'http://localhost:11434',
                        modelName: 'qwen3:8b',
                        apiKey: '',
                        temperature: 0.1,
                        maxTokens: 4096,
                        timeoutMs: 300000,
                        opencodeCliPath: 'opencode',
                    };
                    this.panel?.webview.postMessage({
                        type: 'settings_init',
                        payload: defaults,
                    });
                    this.panel?.webview.postMessage({
                        type: 'settings_test_result',
                        payload: { success: true, message: '已重置为默认设置' },
                    });
                });
                break;
            }
        }
    }

    private async saveSettings(settings: Record<string, unknown>): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('msagent');
        const entries = Object.entries(settings);
        for (const [key, value] of entries) {
            if (value !== undefined) {
                await cfg.update(key, value, true);
            }
        }
    }

    private async resetSettings(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('msagent');
        const keys = [
            'agentMode',
            'modelEndpoint',
            'modelName',
            'apiKey',
            'temperature',
            'maxTokens',
            'timeoutMs',
            'opencodeCliPath',
        ];
        for (const key of keys) {
            await cfg.update(key, undefined, true);
        }
    }

    private async testConnection(settings: Record<string, unknown>): Promise<{ success: boolean; message: string }> {
        const agentMode = settings.agentMode as string;

        if (agentMode === 'opencode') {
            return { success: true, message: 'OpenCode 模式跳过连接测试，请确保 OpenCode 已正确安装。' };
        }

        const endpoint = settings.modelEndpoint as string;
        const modelName = settings.modelName as string;
        const apiKey = settings.apiKey as string;

        try {
            const { OpenAICompatProvider } = await import('../llm/openaiCompatProvider');
            const llm = new OpenAICompatProvider({
                endpoint,
                modelName,
                timeoutMs: 30000,
                apiKey,
            });
            await llm.chat(
                [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
                [],
            );
            return { success: true, message: `连接成功！模型 ${modelName} 可正常使用。` };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return { success: false, message: `连接失败: ${msg}` };
        }
    }

    private getHTML(webview: vscode.Webview): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>msAgent 设置</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
            background-color: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #cccccc);
            padding: 24px 32px;
            line-height: 1.6;
            max-width: 720px;
            margin: 0 auto;
        }
        h1 {
            font-size: 22px;
            font-weight: 600;
            margin-bottom: 4px;
            color: var(--vscode-foreground, #cccccc);
        }
        .subtitle {
            font-size: 12px;
            opacity: 0.6;
            margin-bottom: 28px;
        }
        .section {
            background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.05));
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
        }
        .section-title {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 16px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
            color: var(--vscode-foreground, #cccccc);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .section-icon {
            font-size: 16px;
        }
        .form-row {
            margin-bottom: 16px;
        }
        .form-row:last-child {
            margin-bottom: 0;
        }
        label {
            display: block;
            font-size: 12px;
            font-weight: 500;
            margin-bottom: 6px;
            color: var(--vscode-foreground, #cccccc);
        }
        .hint {
            font-size: 11px;
            opacity: 0.55;
            margin-top: 4px;
            line-height: 1.5;
        }
        input[type="text"],
        input[type="number"],
        input[type="password"] {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            border-radius: 4px;
            background: var(--vscode-input-background, #3c3c3c);
            color: var(--vscode-input-foreground, #cccccc);
            font-size: 13px;
            font-family: inherit;
            outline: none;
            transition: border-color 0.2s;
        }
        input[type="text"]:focus,
        input[type="number"]:focus,
        input[type="password"]:focus {
            border-color: var(--vscode-focusBorder, #0078d4);
        }
        input[type="range"] {
            width: 100%;
            margin: 8px 0;
        }
        .range-value {
            font-size: 12px;
            font-weight: 500;
            color: var(--vscode-textLink-foreground, #3794ff);
            margin-left: 8px;
        }
        select {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            border-radius: 4px;
            background: var(--vscode-dropdown-background, #3c3c3c);
            color: var(--vscode-dropdown-foreground, #cccccc);
            font-size: 13px;
            font-family: inherit;
            outline: none;
            cursor: pointer;
        }
        select:focus {
            border-color: var(--vscode-focusBorder, #0078d4);
        }
        .radio-group {
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
        }
        .radio-option {
            display: flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
            font-size: 13px;
            padding: 6px 12px;
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border, #3c3c3c);
            background: var(--vscode-editor-background, #1e1e1e);
            transition: all 0.2s;
        }
        .radio-option:hover {
            border-color: var(--vscode-focusBorder, #0078d4);
        }
        .radio-option.selected {
            border-color: var(--vscode-textLink-foreground, #3794ff);
            background: var(--vscode-textLink-activeForeground, rgba(55,148,255,0.15));
        }
        .radio-option input {
            cursor: pointer;
        }
        .hidden {
            display: none !important;
        }
        .actions {
            display: flex;
            gap: 12px;
            margin-top: 24px;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
        }
        button {
            padding: 8px 20px;
            border-radius: 4px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            border: none;
            font-family: inherit;
            transition: opacity 0.2s;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        button:hover {
            opacity: 0.85;
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .btn-primary {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #ffffff);
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground, #3c3c3c);
            color: var(--vscode-button-secondaryForeground, #cccccc);
        }
        .btn-danger {
            background: var(--vscode-errorForeground, #f44336);
            color: #ffffff;
        }
        .toast {
            position: fixed;
            bottom: 24px;
            right: 24px;
            padding: 12px 20px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 500;
            max-width: 400px;
            animation: slideIn 0.3s ease;
            z-index: 1000;
        }
        .toast.success {
            background: var(--vscode-testing-iconPassed, rgba(76,175,80,0.2));
            color: var(--vscode-testing-iconPassed, #4caf50);
            border: 1px solid var(--vscode-testing-iconPassed, #4caf50);
        }
        .toast.error {
            background: var(--vscode-testing-iconFailed, rgba(244,67,54,0.2));
            color: var(--vscode-testing-iconFailed, #f44336);
            border: 1px solid var(--vscode-testing-iconFailed, #f44336);
        }
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        .spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255,255,255,0.3);
            border-top-color: currentColor;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <h1>msAgent 设置</h1>
    <div class="subtitle">配置修复引擎和模型参数</div>

    <div class="section">
        <div class="section-title"><span class="section-icon">🔧</span> 修复引擎</div>
        <div class="form-row">
            <label>Agent Mode</label>
            <div class="radio-group" id="agentModeGroup">
                <label class="radio-option selected">
                    <input type="radio" name="agentMode" value="builtin" checked>
                    <span>内置 Agent (Builtin)</span>
                </label>
                <label class="radio-option">
                    <input type="radio" name="agentMode" value="opencode">
                    <span>OpenCode</span>
                </label>
            </div>
            <div class="hint">选择修复后端模式。内置模式使用用户配置的 LLM；OpenCode 模式使用 OpenCode CLI。</div>
        </div>
    </div>

    <div class="section" id="modelSection">
        <div class="section-title"><span class="section-icon">🤖</span> 模型配置（内置 Agent）</div>
        <div class="form-row">
            <label>API 地址</label>
            <input type="text" id="modelEndpoint" placeholder="http://localhost:11434">
            <div class="hint">Ollama: http://localhost:11434 | vLLM: http://localhost:8000</div>
        </div>
        <div class="form-row">
            <label>模型名称</label>
            <input type="text" id="modelName" placeholder="qwen3:8b">
            <div class="hint">需与服务端可用模型一致，如 qwen3-coder:30b、qwen3:8b</div>
        </div>
        <div class="form-row">
            <label>API 密钥</label>
            <input type="password" id="apiKey" placeholder="留空表示无需密钥">
            <div class="hint">本地服务（Ollama）留空即可，云端服务需填写</div>
        </div>
        <div class="form-row">
            <label>采样温度 <span class="range-value" id="tempValue">0.1</span></label>
            <input type="range" id="temperature" min="0" max="2" step="0.1" value="0.1">
            <div class="hint">值越低输出越确定性，建议保持 0.1 以获得稳定的修复结果</div>
        </div>
        <div class="form-row">
            <label>最大 Token 数</label>
            <input type="number" id="maxTokens" min="256" max="32768" step="1">
        </div>
        <div class="form-row">
            <label>超时时间（毫秒）</label>
            <input type="number" id="timeoutMs" min="30000" max="600000" step="1000">
            <div class="hint">默认 300000ms（5分钟），复杂修复可增至 600000ms（10分钟）</div>
        </div>
    </div>

    <div class="section hidden" id="opencodeSection">
        <div class="section-title"><span class="section-icon">⚙️</span> OpenCode 设置</div>
        <div class="form-row">
            <label>CLI 路径</label>
            <input type="text" id="opencodeCliPath" placeholder="opencode">
            <div class="hint">OpenCode CLI 可执行文件路径，默认使用系统 PATH 中的 opencode</div>
        </div>
    </div>

    <div class="actions">
        <button class="btn-primary" id="testBtn">
            <span>测试连接</span>
        </button>
        <button class="btn-primary" id="saveBtn">
            <span>保存设置</span>
        </button>
        <button class="btn-secondary" id="resetBtn">
            <span>重置默认</span>
        </button>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let currentSettings = {};

        function getInput(id) {
            return document.getElementById(id);
        }

        function getValue(id) {
            const el = getInput(id);
            if (!el) return undefined;
            if (el.type === 'number') {
                const v = parseFloat(el.value);
                return isNaN(v) ? undefined : v;
            }
            return el.value;
        }

        function setValue(id, value) {
            const el = getInput(id);
            if (!el) return;
            el.value = value !== undefined && value !== null ? value : '';
        }

        function collectSettings() {
            const agentModeEl = document.querySelector('input[name="agentMode"]:checked');
            return {
                agentMode: agentModeEl ? agentModeEl.value : 'builtin',
                modelEndpoint: getValue('modelEndpoint') || 'http://localhost:11434',
                modelName: getValue('modelName') || 'qwen3:8b',
                apiKey: getValue('apiKey') || '',
                temperature: getValue('temperature') ?? 0.1,
                maxTokens: getValue('maxTokens') ?? 4096,
                timeoutMs: getValue('timeoutMs') ?? 300000,
                opencodeCliPath: getValue('opencodeCliPath') || 'opencode',
            };
        }

        function updateVisibility() {
            const agentMode = document.querySelector('input[name="agentMode"]:checked')?.value || 'builtin';
            const modelSection = document.getElementById('modelSection');
            const opencodeSection = document.getElementById('opencodeSection');

            if (agentMode === 'builtin') {
                modelSection.classList.remove('hidden');
                opencodeSection.classList.add('hidden');
            } else {
                modelSection.classList.add('hidden');
                opencodeSection.classList.remove('hidden');
            }
        }

        function updateRadioSelection(groupName, value) {
            document.querySelectorAll('input[name="' + groupName + '"]').forEach(function(radio) {
                radio.checked = radio.value === value;
                radio.closest('.radio-option').classList.toggle('selected', radio.value === value);
            });
        }

        function showToast(success, message) {
            const existing = document.querySelector('.toast');
            if (existing) existing.remove();

            const toast = document.createElement('div');
            toast.className = 'toast ' + (success ? 'success' : 'error');
            toast.textContent = message;
            document.body.appendChild(toast);

            setTimeout(function() {
                toast.style.opacity = '0';
                toast.style.transition = 'opacity 0.3s';
                setTimeout(function() { toast.remove(); }, 300);
            }, 4000);
        }

        function setLoading(btn, loading) {
            if (loading) {
                btn.disabled = true;
                btn.dataset.originalText = btn.innerHTML;
                btn.innerHTML = '<span class="spinner"></span><span>处理中...</span>';
            } else {
                btn.disabled = false;
                btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
            }
        }

        document.querySelectorAll('input[name="agentMode"]').forEach(function(radio) {
            radio.addEventListener('change', function() {
                updateRadioSelection('agentMode', this.value);
                updateVisibility();
            });
        });

        getInput('temperature').addEventListener('input', function() {
            document.getElementById('tempValue').textContent = this.value;
        });

        document.getElementById('saveBtn').addEventListener('click', function() {
            const btn = this;
            setLoading(btn, true);
            vscode.postMessage({
                type: 'settings_save',
                payload: collectSettings(),
            });
        });

        document.getElementById('testBtn').addEventListener('click', function() {
            const btn = this;
            setLoading(btn, true);
            vscode.postMessage({
                type: 'settings_test_connection',
                payload: collectSettings(),
            });
        });

        document.getElementById('resetBtn').addEventListener('click', function() {
            if (confirm('确定要重置所有设置为默认值吗？')) {
                vscode.postMessage({
                    type: 'settings_reset',
                    payload: {},
                });
            }
        });

        window.addEventListener('message', function(event) {
            const msg = event.data;
            if (msg.type === 'settings_init') {
                const s = msg.payload;
                currentSettings = s;
                setValue('modelEndpoint', s.modelEndpoint);
                setValue('modelName', s.modelName);
                setValue('apiKey', s.apiKey);
                setValue('temperature', s.temperature);
                setValue('maxTokens', s.maxTokens);
                setValue('timeoutMs', s.timeoutMs);
                setValue('opencodeCliPath', s.opencodeCliPath);
                document.getElementById('tempValue').textContent = s.temperature ?? 0.1;
                updateRadioSelection('agentMode', s.agentMode || 'builtin');
                updateVisibility();
            } else if (msg.type === 'settings_test_result') {
                setLoading(document.getElementById('testBtn'), false);
                setLoading(document.getElementById('saveBtn'), false);
                showToast(msg.payload.success, msg.payload.message);
            }
        });

        updateVisibility();
    </script>
</body>
</html>`;
    }
}
