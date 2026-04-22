import * as vscode from 'vscode';
import { WebviewMessage } from './messages';
import { fixDetailsScript } from './fixDetailsScript';

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export class WebviewPanelProvider {
    private panel: vscode.WebviewPanel | undefined;
    private webviewReady = false;
    private messageIdCounter = 0;
    private onActionCallback: ((message: any) => void) | undefined;
    private lastQueueState: WebviewMessage | undefined;
    private sessionMessages: WebviewMessage[] = [];
    private static readonly MAX_SESSION_MESSAGES = 2000;

    createOrShow(context: vscode.ExtensionContext): vscode.WebviewPanel {
        console.log('[WebviewPanelProvider] createOrShow called');
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            return this.panel;
        }

        this.panel = vscode.window.createWebviewPanel(
            'msAgentFix',
            'msAgent Fix Details',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );
        this.webviewReady = false;
        this.panel.webview.html = this.getHTML(this.panel.webview);

        this.panel.webview.onDidReceiveMessage((message: any) => {
            console.log('[WebviewPanelProvider] Received message from webview:', message);
            if (message.type === 'fix_details_ready') {
                if (this.webviewReady) {
                    return;
                }
                this.webviewReady = true;
                console.log('[WebviewPanelProvider] fix_details_ready received');
                if (this.sessionMessages.length > 0) {
                    console.log(
                        `[WebviewPanelProvider] replaying ${this.sessionMessages.length} session messages to webview`,
                    );
                    for (const sessionMessage of this.sessionMessages) {
                        void this.panel?.webview.postMessage(sessionMessage);
                    }
                }
                if (this.lastQueueState) {
                    console.log('[WebviewPanelProvider] replaying last queue_state to webview');
                    void this.panel?.webview.postMessage(this.lastQueueState);
                }
                return;
            }
            if (
                message.type === 'pause_toggle'
                || message.type === 'cancel_current'
                || message.type === 'remove_queued'
            ) {
                this.onActionCallback?.(message);
            }
        });

        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.webviewReady = false;
            this.onActionCallback = undefined;
        });

        return this.panel;
    }

    revealLatestSession(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
        }
    }

    onAction(callback: (message: any) => void): void {
        this.onActionCallback = callback;
    }

    postMessage(message: WebviewMessage): void {
        if (message.type === 'queue_state') {
            this.lastQueueState = message;
            console.log('[WebviewPanelProvider] queue_state payload:', message.payload);
        }
        else {
            this.recordSessionMessage(message);
        }
        if (!this.panel) {
            console.error('[WebviewPanelProvider] postMessage called but panel is undefined!');
            return;
        }
        if (!this.webviewReady) {
            console.log('[WebviewPanelProvider] webview not ready, defer immediate post:', message.type);
            return;
        }
        console.log('[WebviewPanelProvider] postMessage:', message.type);
        this.panel.webview.postMessage(message);
    }

    clear(): void {
        this.sessionMessages = [];
        this.postMessage({ type: 'clear', payload: {} });
        this.messageIdCounter = 0;
    }

    nextMessageId(): string {
        return 'msg_' + (++this.messageIdCounter) + '_' + Date.now();
    }

    private recordSessionMessage(message: WebviewMessage): void {
        if (message.type === 'clear') {
            this.sessionMessages = [];
            return;
        }
        this.sessionMessages.push(message);
        if (this.sessionMessages.length > WebviewPanelProvider.MAX_SESSION_MESSAGES) {
            this.sessionMessages.splice(
                0,
                this.sessionMessages.length - WebviewPanelProvider.MAX_SESSION_MESSAGES,
            );
        }
    }

    private getHTML(webview: vscode.Webview): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>msAgent Fix Details</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body {
            height: 100%;
        }
        body {
            font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
            background-color: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
            line-height: 1.5;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            padding: 16px;
            padding-top: 48px;
            min-height: 100vh;
            box-sizing: border-box;
        }
        .main-column {
            flex: 1 1 auto;
            min-height: 0;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .bottom-dock {
            flex: 0 0 auto;
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding-top: 4px;
        }
        #debug-info {
            display: none;
        }
        #messages {
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto;
            overflow-x: hidden;
            padding-right: 4px;
        }
        .message {
            margin-bottom: 16px;
            border-left: 3px solid #3c3c3c;
            padding: 8px 12px;
            background: rgba(255,255,255,0.02);
            border-radius: 4px;
        }
        .message.assistant { border-color: #4caf50; }
        .message.tool { border-color: #ff9800; }
        .message.diff { border-color: #007acc; }
        .message-header {
            font-size: 12px;
            opacity: 0.7;
            margin-bottom: 8px;
            text-transform: uppercase;
        }
        .content {
            white-space: pre-wrap;
            word-break: break-word;
        }
        .streaming-cursor::after {
            content: "▌";
            animation: blink 1s infinite;
            color: #007acc;
        }
        @keyframes blink { 50% { opacity: 0; } }
        .toolbar {
            position: fixed;
            top: 8px;
            right: 8px;
            z-index: 100;
            display: flex;
            gap: 8px;
        }
        .stop-btn, .cancel-btn {
            min-width: 92px;
            padding: 7px 14px;
            border-radius: 4px;
            border: none;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            box-sizing: border-box;
            text-align: center;
        }
        .stop-btn {
            background: #6c757d;
            color: white;
        }
        .cancel-btn {
            background: #c42b1c;
            color: white;
        }
        .queue-panel {
            flex: 0 0 auto;
            width: 100%;
            margin-top: 12px;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 6px;
            overflow: hidden;
        }
        .queue-header {
            padding: 8px 12px;
            cursor: pointer;
            font-size: 12px;
            opacity: 0.9;
            user-select: none;
        }
        .queue-body {
            border-top: 1px solid rgba(255,255,255,0.08);
            max-height: 180px;
            overflow: auto;
        }
        .queue-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            font-size: 12px;
        }
        .queue-remove {
            background: transparent;
            border: none;
            color: #f44336;
            cursor: pointer;
            font-size: 14px;
        }
        .hidden { display: none; }

        /* Backend badge */
        .backend-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            margin-bottom: 12px;
        }
        .backend-badge .mode {
            opacity: 0.7;
            font-weight: 400;
        }

        /* Degraded banner */
        .degraded-banner {
            padding: 10px 12px;
            border-radius: 6px;
            margin-bottom: 12px;
            font-size: 12px;
            background: var(--vscode-inputValidation-warningBackground);
            color: var(--vscode-editorWarning-foreground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
        }
        .degraded-banner::before {
            content: "⚠️ ";
        }

        /* Phase indicator */
        .phase-indicator {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 12px;
            border-radius: 6px;
            margin-bottom: 12px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            font-size: 13px;
        }
        .phase-indicator .spinner {
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-badge-background);
            border-top-color: var(--vscode-progressBar-background);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .phase-indicator.completed .spinner { display: none; }
        .phase-indicator.error .spinner { display: none; }

        /* Timeline */
        .timeline {
            display: flex;
            flex-direction: column;
            gap: 0;
            margin-bottom: 16px;
        }
        .timeline-step {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 8px 0;
            position: relative;
        }
        .timeline-step::before {
            content: "";
            position: absolute;
            left: 11px;
            top: 28px;
            bottom: -8px;
            width: 2px;
            background: var(--vscode-editorWidget-border);
        }
        .timeline-step:last-child::before { display: none; }
        .timeline-step .step-icon {
            width: 22px;
            height: 22px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            flex-shrink: 0;
            z-index: 1;
            background: var(--vscode-editor-background);
            border: 2px solid var(--vscode-editorWidget-border);
        }
        .timeline-step.running .step-icon {
            border-color: var(--vscode-progressBar-background);
        }
        .timeline-step.success .step-icon {
            border-color: var(--vscode-testing-iconPassed);
            color: var(--vscode-testing-iconPassed);
        }
        .timeline-step.error .step-icon {
            border-color: var(--vscode-testing-iconFailed);
            color: var(--vscode-testing-iconFailed);
        }
        .timeline-step .step-body {
            flex: 1;
            min-width: 0;
        }
        .timeline-step .step-title {
            font-size: 12px;
            font-weight: 500;
        }
        .timeline-step .step-detail {
            font-size: 11px;
            opacity: 0.7;
            margin-top: 2px;
            word-break: break-word;
        }

        /* Diff cards */
        .diff-cards {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 16px;
        }
        .diff-card {
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 6px;
            overflow: hidden;
        }
        .diff-card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            font-size: 12px;
            font-family: var(--vscode-editor-font-family);
        }
        .diff-card-summary {
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 10px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .diff-card-body {
            padding: 8px 0;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            overflow-x: auto;
        }
        .diff-line {
            padding: 1px 12px;
            white-space: pre;
        }
        .diff-line.add {
            background: var(--vscode-diffEditor-insertedLineBackground, rgba(155,185,85,0.15));
            border-left: 3px solid var(--vscode-editorGutter-addedBackground, #4caf50);
        }
        .diff-line.remove {
            background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.1));
            border-left: 3px solid var(--vscode-editorGutter-deletedBackground, #f44336);
        }
        .diff-line.context {
            border-left: 3px solid transparent;
        }
        .diff-line .line-num {
            display: inline-block;
            width: 30px;
            text-align: right;
            opacity: 0.4;
            margin-right: 8px;
            user-select: none;
        }

        /* Session result */
        .session-result {
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 16px;
            font-size: 13px;
        }
        .session-result.success {
            border-left: 3px solid var(--vscode-testing-iconPassed, #4caf50);
            background: rgba(76,175,80,0.08);
        }
        .session-result.failed {
            border-left: 3px solid var(--vscode-testing-iconFailed, #f44336);
            background: rgba(244,67,54,0.08);
        }
        .session-result.cancelled {
            border-left: 3px solid var(--vscode-descriptionForeground, #888);
            background: rgba(128,128,128,0.08);
        }
    </style>
</head>
<body>
    <div id="debug-info">Loading...</div>
    <div class="toolbar">
        <button id="stopBtn" class="stop-btn hidden">Pause</button>
        <button id="cancelBtn" class="cancel-btn hidden">Cancel</button>
    </div>
    <div class="main-column">
        <div id="backendBadge" class="hidden"></div>
        <div id="degradedBanner" class="hidden"></div>
        <div id="phaseIndicator" class="hidden"></div>
        <div id="timeline" class="hidden"></div>
        <div id="diffCards" class="hidden"></div>
        <div id="sessionResult" class="hidden"></div>
        <div id="messages"></div>
        <div class="bottom-dock">
            <div id="queuePanel" class="queue-panel hidden">
                <div id="queueHeader" class="queue-header">0 problems queued</div>
                <div id="queueBody" class="queue-body hidden"></div>
            </div>
        </div>
    </div>
    <script nonce="${nonce}">
${fixDetailsScript}
    </script>
</body>
</html>`;
    }
}
