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
        return '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'    <meta charset="UTF-8">\n' +
'    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'    <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + webview.cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">\n' +
'    <title>msAgent Fix Details</title>\n' +
'    <style>\n' +
'        * { box-sizing: border-box; margin: 0; padding: 0; }\n' +
'        html, body {\n' +
'            height: 100%;\n' +
'        }\n' +
'        body {\n' +
'            font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, sans-serif);\n' +
'            background-color: var(--vscode-editor-background, #1e1e1e);\n' +
'            color: var(--vscode-editor-foreground, #d4d4d4);\n' +
'            line-height: 1.5;\n' +
'            display: flex;\n' +
'            flex-direction: column;\n' +
'            overflow: hidden;\n' +
'            padding: 16px;\n' +
'            padding-top: 48px;\n' +
'            min-height: 100vh;\n' +
'            box-sizing: border-box;\n' +
'        }\n' +
'        .main-column {\n' +
'            flex: 1 1 auto;\n' +
'            min-height: 0;\n' +
'            display: flex;\n' +
'            flex-direction: column;\n' +
'            overflow: hidden;\n' +
'        }\n' +
'        .bottom-dock {\n' +
'            flex: 0 0 auto;\n' +
'            display: flex;\n' +
'            flex-direction: column;\n' +
'            gap: 10px;\n' +
'            padding-top: 4px;\n' +
'        }\n' +
'        #debug-info {\n' +
'            display: none;\n' +
'        }\n' +
'        #messages {\n' +
'            flex: 1 1 auto;\n' +
'            min-height: 0;\n' +
'            overflow-y: auto;\n' +
'            overflow-x: hidden;\n' +
'            padding-right: 4px;\n' +
'        }\n' +
'        .message {\n' +
'            margin-bottom: 16px;\n' +
'            border-left: 3px solid #3c3c3c;\n' +
'            padding: 8px 12px;\n' +
'            background: rgba(255,255,255,0.02);\n' +
'            border-radius: 4px;\n' +
'        }\n' +
'        .message.assistant { border-color: #4caf50; }\n' +
'        .message.tool { border-color: #ff9800; }\n' +
'        .message.diff { border-color: #007acc; }\n' +
'        .message-header {\n' +
'            font-size: 12px;\n' +
'            opacity: 0.7;\n' +
'            margin-bottom: 8px;\n' +
'            text-transform: uppercase;\n' +
'        }\n' +
'        .content {\n' +
'            white-space: pre-wrap;\n' +
'            word-break: break-word;\n' +
'        }\n' +
'        .streaming-cursor::after {\n' +
'            content: "▌";\n' +
'            animation: blink 1s infinite;\n' +
'            color: #007acc;\n' +
'        }\n' +
'        @keyframes blink { 50% { opacity: 0; } }\n' +
'        .toolbar {\n' +
'            position: fixed;\n' +
'            top: 8px;\n' +
'            right: 8px;\n' +
'            z-index: 100;\n' +
'            display: flex;\n' +
'            gap: 8px;\n' +
'        }\n' +
'        .stop-btn, .cancel-btn {\n' +
'            min-width: 92px;\n' +
'            padding: 7px 14px;\n' +
'            border-radius: 4px;\n' +
'            border: none;\n' +
'            cursor: pointer;\n' +
'            font-size: 12px;\n' +
'            font-weight: 600;\n' +
'            box-sizing: border-box;\n' +
'            text-align: center;\n' +
'        }\n' +
'        .stop-btn {\n' +
'            background: #6c757d;\n' +
'            color: white;\n' +
'        }\n' +
'        .cancel-btn {\n' +
'            background: #c42b1c;\n' +
'            color: white;\n' +
'        }\n' +
'        .queue-panel {\n' +
'            flex: 0 0 auto;\n' +
'            width: 100%;\n' +
'            margin-top: 12px;\n' +
'            background: rgba(255,255,255,0.04);\n' +
'            border: 1px solid rgba(255,255,255,0.12);\n' +
'            border-radius: 6px;\n' +
'            overflow: hidden;\n' +
'        }\n' +
'        .queue-header {\n' +
'            padding: 8px 12px;\n' +
'            cursor: pointer;\n' +
'            font-size: 12px;\n' +
'            opacity: 0.9;\n' +
'            user-select: none;\n' +
'        }\n' +
'        .queue-body {\n' +
'            border-top: 1px solid rgba(255,255,255,0.08);\n' +
'            max-height: 180px;\n' +
'            overflow: auto;\n' +
'        }\n' +
'        .queue-item {\n' +
'            display: flex;\n' +
'            justify-content: space-between;\n' +
'            align-items: center;\n' +
'            gap: 8px;\n' +
'            padding: 8px 12px;\n' +
'            font-size: 12px;\n' +
'        }\n' +
'        .queue-remove {\n' +
'            background: transparent;\n' +
'            border: none;\n' +
'            color: #f44336;\n' +
'            cursor: pointer;\n' +
'            font-size: 14px;\n' +
'        }\n' +
'        .hidden { display: none; }\n' +
'    </style>\n' +
'</head>\n' +
'<body>\n' +
'    <div id="debug-info">Loading...</div>\n' +
'    <div class="toolbar">\n' +
'        <button id="stopBtn" class="stop-btn hidden">Pause</button>\n' +
'        <button id="cancelBtn" class="cancel-btn hidden">Cancel</button>\n' +
'    </div>\n' +
'    <div class="main-column">\n' +
'        <div id="messages"></div>\n' +
'        <div class="bottom-dock">\n' +
'            <div id="queuePanel" class="queue-panel hidden">\n' +
'                <div id="queueHeader" class="queue-header">0 problems queued</div>\n' +
'                <div id="queueBody" class="queue-body hidden"></div>\n' +
'            </div>\n' +
'        </div>\n' +
'    </div>\n' +
'    <script nonce="' + nonce + '">\n' +
'        var vscode = acquireVsCodeApi();\n' +
'        var debugInfo = document.getElementById("debug-info");\n' +
'        var container = document.getElementById("messages");\n' +
'        var stopBtn = document.getElementById("stopBtn");\n' +
'        var cancelBtn = document.getElementById("cancelBtn");\n' +
'        var queuePanel = document.getElementById("queuePanel");\n' +
'        var queueHeader = document.getElementById("queueHeader");\n' +
'        var queueBody = document.getElementById("queueBody");\n' +
'        var messageMap = new Map();\n' +
'        var queueExpanded = false;\n' +
'        var lastQueueHeaderBody = "0 problems queued";\n' +
'        \n' +
'        function log(msg) {\n' +
'            console.log("[WebView] " + msg);\n' +
'            if (debugInfo) debugInfo.textContent = msg;\n' +
'        }\n' +
'        \n' +
'        log("Script loaded");\n' +
'        \n' +
'        var toolCallMap = new Map();\n' +
'        \n' +
'        window.addEventListener("message", function(event) {\n' +
'            var msg = event.data;\n' +
'            log("Received: " + msg.type);\n' +
'            \n' +
'            if (msg.type === "clear") {\n' +
'                if (container) container.innerHTML = "";\n' +
'                messageMap.clear();\n' +
'                toolCallMap.clear();\n' +
'                if (stopBtn) {\n' +
'                    stopBtn.classList.add("hidden");\n' +
'                    stopBtn.disabled = false;\n' +
'                    stopBtn.textContent = "Pause";\n' +
'                }\n' +
'                if (cancelBtn) {\n' +
'                    cancelBtn.classList.add("hidden");\n' +
'                    cancelBtn.disabled = false;\n' +
'                    cancelBtn.textContent = "Cancel";\n' +
'                }\n' +
'            } else if (msg.type === "text_stream") {\n' +
'                appendText(msg.payload.messageId, msg.payload.delta);\n' +
'            } else if (msg.type === "tool_call") {\n' +
'                appendToolCall(msg.payload);\n' +
'            } else if (msg.type === "tool_result") {\n' +
'                appendToolResult(msg.payload);\n' +
'            } else if (msg.type === "diff") {\n' +
'                appendDiff(msg.payload);\n' +
'            } else if (msg.type === "final_diff") {\n' +
'                appendFinalDiff(msg.payload);\n' +
'            } else if (msg.type === "message_complete") {\n' +
'                completeMessage(msg.payload.messageId);\n' +
'            } else if (msg.type === "error") {\n' +
'                showError(msg.payload.message);\n' +
'            } else if (msg.type === "queue_state") {\n' +
'                renderQueueState(msg.payload);\n' +
'            }\n' +
'        });\n' +
'        \n' +
'        if (stopBtn) {\n' +
'            stopBtn.addEventListener("click", function() {\n' +
'                vscode.postMessage({ type: "pause_toggle" });\n' +
'            });\n' +
'        }\n' +
'        if (cancelBtn) {\n' +
'            cancelBtn.addEventListener("click", function() {\n' +
'                cancelBtn.disabled = true;\n' +
'                vscode.postMessage({ type: "cancel_current" });\n' +
'            });\n' +
'        }\n' +
'        if (queueHeader) {\n' +
'            queueHeader.addEventListener("click", function() {\n' +
'                queueExpanded = !queueExpanded;\n' +
'                if (queueBody) {\n' +
'                    if (queueExpanded) queueBody.classList.remove("hidden");\n' +
'                    else queueBody.classList.add("hidden");\n' +
'                }\n' +
'                queueHeader.textContent = (queueExpanded ? "▼ " : "▶ ") + lastQueueHeaderBody;\n' +
'            });\n' +
'        }\n' +
'        \n' +
'        function appendText(messageId, delta) {\n' +
'            log("appendText: " + messageId);\n' +
'            var el = messageMap.get(messageId);\n' +
'            if (!el) {\n' +
'                el = document.createElement("div");\n' +
'                el.className = "message assistant";\n' +
'                var header = document.createElement("div");\n' +
'                header.className = "message-header";\n' +
'                header.textContent = "Assistant";\n' +
'                el.appendChild(header);\n' +
'                var content = document.createElement("div");\n' +
'                content.className = "content streaming-cursor";\n' +
'                el.appendChild(content);\n' +
'                if (container) container.appendChild(el);\n' +
'                messageMap.set(messageId, el);\n' +
'            }\n' +
'            var content = el.querySelector(".content");\n' +
'            if (content) {\n' +
'                content.textContent += delta;\n' +
'                if (container) container.scrollTop = container.scrollHeight;\n' +
'            }\n' +
'        }\n' +
'        \n' +
'        function completeMessage(messageId) {\n' +
'            var el = messageMap.get(messageId);\n' +
'            if (el) {\n' +
'                var content = el.querySelector(".content");\n' +
'                if (content) content.classList.remove("streaming-cursor");\n' +
'            }\n' +
'        }\n' +
'        \n' +
'        function showError(message) {\n' +
'            var el = document.createElement("div");\n' +
'            el.style.padding = "12px";\n' +
'            el.style.background = "rgba(244,67,54,0.1)";\n' +
'            el.style.borderLeft = "3px solid #f44336";\n' +
'            el.style.borderRadius = "4px";\n' +
'            el.style.color = "#f44336";\n' +
'            el.textContent = "Error: " + message;\n' +
'            if (container) container.appendChild(el);\n' +
'        }\n' +
'        \n' +
'        function renderQueueState(payload) {\n' +
'            if (!queuePanel || !queueHeader || !queueBody) return;\n' +
'            var items = payload.items || [];\n' +
'            var n = items.length;\n' +
'            var sessionPaused = Boolean(payload.paused);\n' +
'            if (n > 0) {\n' +
'                queuePanel.classList.remove("hidden");\n' +
'                queueExpanded = true;\n' +
'                queueBody.classList.remove("hidden");\n' +
'                lastQueueHeaderBody = sessionPaused\n' +
'                    ? ("Paused · " + n + " queued")\n' +
'                    : (n + " problem" + (n === 1 ? "" : "s") + " queued");\n' +
'                queueHeader.textContent = "▼ " + lastQueueHeaderBody;\n' +
'                queueBody.innerHTML = "";\n' +
'                items.forEach(function(item) {\n' +
'                    var row = document.createElement("div");\n' +
'                    row.className = "queue-item";\n' +
'                    var text = document.createElement("span");\n' +
'                    text.textContent = item.title;\n' +
'                    row.appendChild(text);\n' +
'                    var removeBtn = document.createElement("button");\n' +
'                    removeBtn.className = "queue-remove";\n' +
'                    removeBtn.textContent = "🗑";\n' +
'                    removeBtn.addEventListener("click", function(e) {\n' +
'                        e.stopPropagation();\n' +
'                        vscode.postMessage({ type: "remove_queued", id: item.id });\n' +
'                    });\n' +
'                    row.appendChild(removeBtn);\n' +
'                    queueBody.appendChild(row);\n' +
'                });\n' +
'            } else {\n' +
'                queuePanel.classList.add("hidden");\n' +
'                queueExpanded = false;\n' +
'                queueBody.classList.add("hidden");\n' +
'                queueBody.innerHTML = "";\n' +
'                lastQueueHeaderBody = "0 problems queued";\n' +
'                queueHeader.textContent = "▶ " + lastQueueHeaderBody;\n' +
'            }\n' +
'            if (stopBtn) {\n' +
'                if (payload.hasPendingTasks) {\n' +
'                    stopBtn.classList.remove("hidden");\n' +
'                    stopBtn.disabled = false;\n' +
'                    stopBtn.textContent = payload.paused ? "Resume" : "Pause";\n' +
'                } else {\n' +
'                    stopBtn.classList.add("hidden");\n' +
'                }\n' +
'            }\n' +
'            if (cancelBtn) {\n' +
'                if (payload.hasPendingTasks) {\n' +
'                    cancelBtn.classList.remove("hidden");\n' +
'                    cancelBtn.disabled = false;\n' +
'                    cancelBtn.textContent = n > 0 ? "Skip" : "Cancel";\n' +
'                } else {\n' +
'                    cancelBtn.classList.add("hidden");\n' +
'                }\n' +
'            }\n' +
'        }\n' +
'        \n' +
'        function appendToolCall(payload) {\n' +
'            log("appendToolCall: " + payload.name);\n' +
'            var el = document.createElement("div");\n' +
'            el.className = "message tool";\n' +
'            var header = document.createElement("div");\n' +
'            header.className = "message-header";\n' +
'            header.textContent = "Tool Call: " + payload.name;\n' +
'            el.appendChild(header);\n' +
'            var params = document.createElement("pre");\n' +
'            params.style.margin = "8px 0";\n' +
'            params.style.padding = "8px";\n' +
'            params.style.background = "rgba(0,0,0,0.2)";\n' +
'            params.style.borderRadius = "4px";\n' +
'            params.style.overflow = "auto";\n' +
'            params.style.fontSize = "12px";\n' +
'            params.textContent = JSON.stringify(payload.params, null, 2);\n' +
'            el.appendChild(params);\n' +
'            if (container) container.appendChild(el);\n' +
'            toolCallMap.set(payload.toolCallId, el);\n' +
'        }\n' +
'        \n' +
'        function appendToolResult(payload) {\n' +
'            log("appendToolResult: " + payload.toolCallId);\n' +
'            var el = toolCallMap.get(payload.toolCallId);\n' +
'            if (el) {\n' +
'                var result = document.createElement("div");\n' +
'                result.style.marginTop = "8px";\n' +
'                result.style.padding = "8px";\n' +
'                result.style.background = payload.isError ? "rgba(244,67,54,0.1)" : "rgba(76,175,80,0.1)";\n' +
'                result.style.borderRadius = "4px";\n' +
'                result.style.fontSize = "12px";\n' +
'                result.style.maxHeight = "200px";\n' +
'                result.style.overflow = "auto";\n' +
'                result.style.color = payload.isError ? "#f44336" : "#4caf50";\n' +
'                result.textContent = payload.result.substring(0, 500) + (payload.result.length > 500 ? "..." : "");\n' +
'                el.appendChild(result);\n' +
'            }\n' +
'        }\n' +
'        \n' +
'        function appendDiff(payload) {\n' +
'            log("appendDiff: " + payload.path);\n' +
'            var el = document.createElement("div");\n' +
'            el.className = "message diff";\n' +
'            var header = document.createElement("div");\n' +
'            header.className = "message-header";\n' +
'            header.textContent = "Diff: " + (payload.path.split("/").pop() || payload.path);\n' +
'            el.appendChild(header);\n' +
'            var diffContent = document.createElement("div");\n' +
'            diffContent.style.marginTop = "8px";\n' +
'            diffContent.style.padding = "12px";\n' +
'            diffContent.style.background = "rgba(0,0,0,0.2)";\n' +
'            diffContent.style.borderRadius = "4px";\n' +
'            diffContent.style.fontFamily = "monospace";\n' +
'            diffContent.style.fontSize = "12px";\n' +
'            diffContent.style.whiteSpace = "pre";\n' +
'            diffContent.style.overflow = "auto";\n' +
'            diffContent.style.maxHeight = "300px";\n' +
'            var oldLines = (payload.oldText || "").split("\\n");\n' +
'            var newLines = (payload.newText || "").split("\\n");\n' +
'            var maxLines = Math.max(oldLines.length, newLines.length);\n' +
'            var diffText = "";\n' +
'            for (var i = 0; i < maxLines; i++) {\n' +
'                var oldLine = oldLines[i] || "";\n' +
'                var newLine = newLines[i] || "";\n' +
'                if (oldLine !== newLine) {\n' +
'                    if (oldLine) diffText += "- " + oldLine + "\\n";\n' +
'                    if (newLine) diffText += "+ " + newLine + "\\n";\n' +
'                }\n' +
'            }\n' +
'            diffContent.textContent = diffText || "(no changes)";\n' +
'            el.appendChild(diffContent);\n' +
'            if (container) container.appendChild(el);\n' +
'        }\n' +
'        \n' +
'        function appendFinalDiff(payload) {\n' +
'            log("appendFinalDiff: " + payload.path);\n' +
'            var separator = document.createElement("div");\n' +
'            separator.style.marginTop = "24px";\n' +
'            separator.style.paddingTop = "16px";\n' +
'            separator.style.borderTop = "2px solid #4caf50";\n' +
'            separator.innerHTML = \'<div style="color: #4caf50; font-weight: bold; margin-bottom: 8px;">✓ Fix Applied</div><div style="opacity: 0.7; font-size: 12px;">File: \' + (payload.path.split("/").pop() || payload.path) + \'</div>\';\n' +
'            if (container) container.appendChild(separator);\n' +
'            \n' +
'            var el = document.createElement("div");\n' +
'            el.className = "message diff";\n' +
'            el.style.marginTop = "16px";\n' +
'            \n' +
'            var oldContent = payload.oldContent || "";\n' +
'            var newContent = payload.newContent || "";\n' +
'            \n' +
'            if (oldContent === newContent) {\n' +
'                el.innerHTML = \'<div style="padding: 12px; opacity: 0.7;">No changes were made to the file.</div>\';\n' +
'            } else {\n' +
'                var table = document.createElement("table");\n' +
'                table.style.width = "100%";\n' +
'                table.style.borderCollapse = "collapse";\n' +
'                table.style.fontSize = "12px";\n' +
'                table.style.fontFamily = "monospace";\n' +
'                \n' +
'                var oldLines = oldContent.split("\\n");\n' +
'                var newLines = newContent.split("\\n");\n' +
'                var changes = [];\n' +
'                \n' +
'                for (var i = 0; i < Math.max(oldLines.length, newLines.length); i++) {\n' +
'                    var oldLine = oldLines[i] || "";\n' +
'                    var newLine = newLines[i] || "";\n' +
'                    if (oldLine !== newLine) {\n' +
'                        changes.push(i);\n' +
'                    }\n' +
'                }\n' +
'                \n' +
'                var showLines = new Set();\n' +
'                changes.forEach(function(changeIdx) {\n' +
'                    for (var i = Math.max(0, changeIdx - 2); i <= Math.min(Math.max(oldLines.length, newLines.length) - 1, changeIdx + 2); i++) {\n' +
'                        showLines.add(i);\n' +
'                    }\n' +
'                });\n' +
'                \n' +
'                var sortedLines = Array.from(showLines).sort(function(a, b) { return a - b; });\n' +
'                \n' +
'                sortedLines.forEach(function(lineIdx) {\n' +
'                    var oldLine = oldLines[lineIdx] || "";\n' +
'                    var newLine = newLines[lineIdx] || "";\n' +
'                    var isChanged = oldLine !== newLine;\n' +
'                    \n' +
'                    var row = table.insertRow();\n' +
'                    \n' +
'                    var oldCell = row.insertCell();\n' +
'                    oldCell.style.padding = "4px 8px";\n' +
'                    oldCell.style.borderBottom = "1px solid #3c3c3c";\n' +
'                    oldCell.style.verticalAlign = "top";\n' +
'                    oldCell.style.background = isChanged ? "rgba(255, 0, 0, 0.1)" : "transparent";\n' +
'                    oldCell.style.textDecoration = isChanged && oldLine ? "line-through" : "none";\n' +
'                    oldCell.style.color = isChanged ? "#f44336" : "#d4d4d4";\n' +
'                    oldCell.innerHTML = \'<span style="opacity: 0.5">\' + (lineIdx + 1) + \'</span> \' + escapeHtml(oldLine);\n' +
'                    \n' +
'                    var newCell = row.insertCell();\n' +
'                    newCell.style.padding = "4px 8px";\n' +
'                    newCell.style.borderBottom = "1px solid #3c3c3c";\n' +
'                    newCell.style.verticalAlign = "top";\n' +
'                    newCell.style.background = isChanged ? "rgba(0, 255, 0, 0.1)" : "transparent";\n' +
'                    newCell.style.color = isChanged ? "#4caf50" : "#d4d4d4";\n' +
'                    newCell.innerHTML = \'<span style="opacity: 0.5">\' + (lineIdx + 1) + \'</span> \' + escapeHtml(newLine);\n' +
'                });\n' +
'                \n' +
'                el.appendChild(table);\n' +
'            }\n' +
'            \n' +
'            if (container) container.appendChild(el);\n' +
'        }\n' +
'        \n' +
'        function escapeHtml(str) {\n' +
'            return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");\n' +
'        }\n' +
'        \n' +
'        log("Ready");\n' +
'        vscode.postMessage({ type: "fix_details_ready" });\n' +
'    </script>\n' +
'</body>\n' +
'</html>';
    }
}