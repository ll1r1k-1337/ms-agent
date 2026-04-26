import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WebviewMessage } from './messages';

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function getOutputChannel(): { appendLine: (msg: string) => void } {
    const globalAny = global as any;
    if (globalAny.msAgentOutputChannel) {
        return globalAny.msAgentOutputChannel;
    }
    return { appendLine: () => {} };
}

export class WebviewPanelProvider {
    private panel: vscode.WebviewPanel | undefined;
    private webviewReady = false;
    private messageIdCounter = 0;
    private onActionCallback: ((message: any) => void) | undefined;
    private lastQueueState: WebviewMessage | undefined;
    private sessionMessages: WebviewMessage[] = [];
    private sessionMessageFlushIndex = 0;
    private static readonly MAX_SESSION_MESSAGES = 2000;
    private autoReadyTimeout: NodeJS.Timeout | undefined;
    private extensionUri: vscode.Uri | undefined;

    createOrShow(context: vscode.ExtensionContext): vscode.WebviewPanel {
        if (this.panel) {
            // Panel already exists — just reveal it.
            // DO NOT reload HTML or reset ready state; that discards the running script
            // and cancels pending auto-ready, causing messages to be lost forever.
            this.panel.reveal(vscode.ViewColumn.Beside);
            return this.panel;
        }

        this.extensionUri = context.extensionUri;
        this.panel = vscode.window.createWebviewPanel(
            'msAgentFix',
            'msAgent Fix Details',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [context.extensionUri],
            },
        );
        this.webviewReady = false;
        this.panel.webview.html = this.getHTML(this.panel.webview, context.extensionUri);
        this.scheduleAutoReady();

        this.panel.webview.onDidReceiveMessage((message: any) => {
            if (message.type === 'fix_details_ready') {
                if (this.autoReadyTimeout) {
                    clearTimeout(this.autoReadyTimeout);
                    this.autoReadyTimeout = undefined;
                }
                const wasAlreadyReady = this.webviewReady;
                this.webviewReady = true;
                const channel = getOutputChannel();
                channel.appendLine('[WebviewPanelProvider] fix_details_ready received');
                if (wasAlreadyReady) {
                    channel.appendLine('[WebviewPanelProvider] real ready arrived after auto-ready; flushing missed messages');
                }
                this.flushSessionMessages();
                return;
            }
            if (message.type === 'webview_debug') {
                const globalAny = global as any;
                const channel = globalAny.msAgentOutputChannel;
                if (channel) {
                    channel.appendLine('[WebViewDebug] ' + (message.payload || ''));
                }
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
            if (this.autoReadyTimeout) {
                clearTimeout(this.autoReadyTimeout);
                this.autoReadyTimeout = undefined;
            }
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
        }
        else {
            this.recordSessionMessage(message);
        }
        if (!this.panel) {
            return;
        }
        if (!this.webviewReady) {
            return;
        }
        this.panel.webview.postMessage(message);
    }

    clear(): void {
        this.sessionMessages = [];
        this.sessionMessageFlushIndex = 0;
        this.postMessage({ type: 'clear', payload: {} });
        this.messageIdCounter = 0;
    }

    nextMessageId(): string {
        return 'msg_' + (++this.messageIdCounter) + '_' + Date.now();
    }

    private scheduleAutoReady(): void {
        if (this.autoReadyTimeout) {
            clearTimeout(this.autoReadyTimeout);
        }
        this.autoReadyTimeout = setTimeout(() => {
            if (!this.webviewReady) {
                const channel = getOutputChannel();
                channel.appendLine('[WebviewPanelProvider] AUTO-READY triggered after 15s (fix_details_ready never received)');
                this.webviewReady = true;
                this.flushSessionMessages();
            }
        }, 15000);
    }

    private flushSessionMessages(): void {
        const channel = getOutputChannel();
        const start = this.sessionMessageFlushIndex;
        const end = this.sessionMessages.length;
        if (end > start) {
            channel.appendLine(`[WebviewPanelProvider] replaying ${end - start} session messages`);
            for (let i = start; i < end; i++) {
                void this.panel?.webview.postMessage(this.sessionMessages[i]);
            }
            this.sessionMessageFlushIndex = end;
        }
        if (this.lastQueueState) {
            channel.appendLine('[WebviewPanelProvider] replaying last queue_state');
            void this.panel?.webview.postMessage(this.lastQueueState);
        }
    }

    private recordSessionMessage(message: WebviewMessage): void {
        if (message.type === 'clear') {
            this.sessionMessages = [];
            this.sessionMessageFlushIndex = 0;
            return;
        }
        this.sessionMessages.push(message);
        if (this.sessionMessages.length > WebviewPanelProvider.MAX_SESSION_MESSAGES) {
            const removed = this.sessionMessages.length - WebviewPanelProvider.MAX_SESSION_MESSAGES;
            this.sessionMessages.splice(0, removed);
            this.sessionMessageFlushIndex = Math.max(0, this.sessionMessageFlushIndex - removed);
        }
    }

    private getHTML(webview: vscode.Webview, extensionUri: vscode.Uri): string {
        const nonce = getNonce();
        const htmlPath = path.join(extensionUri.fsPath, 'media', 'fixPanel.html');
        const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionUri.fsPath, 'media', 'fixPanel.css')));
        const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(extensionUri.fsPath, 'media', 'fixPanel.js')));

        let html = fs.readFileSync(htmlPath, 'utf-8');
        html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
        html = html.replace(/\{\{nonce\}\}/g, nonce);
        html = html.replace(/\{\{styleUri\}\}/g, styleUri.toString());
        html = html.replace(/\{\{scriptUri\}\}/g, scriptUri.toString());

        return html;
    }
}
