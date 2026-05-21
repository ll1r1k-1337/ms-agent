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

export const MSAGENT_FIX_VIEW_TYPE = 'msAgentFix';

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
    /** Last column the user had this panel in; we reveal back into it so we don't bounce to a new editor group. */
    private lastViewColumn: vscode.ViewColumn | undefined;

    /**
     * True when this provider is currently driving an open VS Code webview panel.
     * Useful for the serializer to decide whether to dispose a duplicate.
     */
    hasPanel(): boolean {
        return this.panel !== undefined;
    }

    /**
     * Adopt a webview panel created elsewhere (e.g. one deserialized by VS Code on
     * extension reload) as this provider's singleton panel. The HTML is rehydrated
     * so the panel becomes interactive again — the old session content is gone but
     * future fix runs use this same tab instead of opening a new one.
     */
    adopt(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): void {
        if (this.panel === panel) {
            return;
        }
        if (this.panel) {
            // Caller should only adopt when we don't already own a panel — but be
            // defensive: dispose the incoming panel rather than leave the user with
            // two "msAgent Fix Details" tabs.
            panel.dispose();
            return;
        }
        this.panel = panel;
        this.extensionUri = context.extensionUri;
        this.lastViewColumn = panel.viewColumn ?? this.lastViewColumn;
        this.webviewReady = false;
        // Rehydrate HTML — the deserialized panel has no live script attached.
        this.panel.webview.html = this.getHTML(this.panel.webview, context.extensionUri);
        this.scheduleAutoReady();
        this.wireUpPanelEvents();
    }

    createOrShow(context: vscode.ExtensionContext): vscode.WebviewPanel {
        if (this.panel) {
            // Panel already exists — reveal it in the column where the user has it
            // (or where it last lived) so we never split into a new editor group.
            // DO NOT reload HTML or reset ready state; that discards the running script
            // and cancels pending auto-ready, causing messages to be lost forever.
            const targetColumn = this.panel.viewColumn ?? this.lastViewColumn ?? vscode.ViewColumn.Beside;
            this.panel.reveal(targetColumn, true);
            return this.panel;
        }

        this.extensionUri = context.extensionUri;
        this.panel = vscode.window.createWebviewPanel(
            MSAGENT_FIX_VIEW_TYPE,
            'msAgent Fix Details',
            this.lastViewColumn ?? vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [context.extensionUri],
            },
        );
        this.lastViewColumn = this.panel.viewColumn ?? this.lastViewColumn;
        this.webviewReady = false;
        this.panel.webview.html = this.getHTML(this.panel.webview, context.extensionUri);
        this.scheduleAutoReady();
        this.wireUpPanelEvents();

        return this.panel;
    }

    private wireUpPanelEvents(): void {
        if (!this.panel) {
            return;
        }
        const panel = this.panel;
        panel.webview.onDidReceiveMessage((message: any) => {
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
                || message.type === 'cancel_task'
                || message.type === 'remove_queued'
            ) {
                this.onActionCallback?.(message);
            }
        });

        panel.onDidChangeViewState((event) => {
            const col = event.webviewPanel.viewColumn;
            if (col !== undefined) {
                this.lastViewColumn = col;
            }
        });

        panel.onDidDispose(() => {
            if (this.panel === panel) {
                this.panel = undefined;
                this.webviewReady = false;
                this.onActionCallback = undefined;
                if (this.autoReadyTimeout) {
                    clearTimeout(this.autoReadyTimeout);
                    this.autoReadyTimeout = undefined;
                }
            }
        });
    }

    revealLatestSession(): void {
        if (this.panel) {
            const targetColumn = this.panel.viewColumn ?? this.lastViewColumn ?? vscode.ViewColumn.Beside;
            this.panel.reveal(targetColumn, true);
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
