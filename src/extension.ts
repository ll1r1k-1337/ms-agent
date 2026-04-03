import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DiagnosticsManager } from './vscode/diagnosticsManager';
import { fixDiagnostic, fixProblem, fixAllDiagnostics } from './vscode/fixService';
import { registerFixActions } from './vscode/codeActionProvider';
import { OpenAICompatProvider } from './llm/openaiCompatProvider';
import { getLLMConfig } from './llm/config';
import { Severity } from './parser/types';
import type { ParseResult } from './parser/types';

let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
    console.log('msAgent extension is now active');

    outputChannel = vscode.window.createOutputChannel('msAgent');
    context.subscriptions.push(outputChannel);

    outputChannel.appendLine('========================================');
    outputChannel.appendLine('msAgent extension activated');
    outputChannel.appendLine('Timestamp: ' + new Date().toISOString());
    outputChannel.appendLine('========================================');
    outputChannel.appendLine('');

    (global as any).msAgentContext = context;
    (global as any).msAgentOutputChannel = outputChannel;

    DiagnosticsManager.activate(context);

    await validateLLMConfiguration(context);

    /**
     * Parse a sanitizer log and publish diagnostics.
     * - With `logPath` (Uri or string): parse that file (absolute or workspace-relative).
     * - Without `logPath`: open file dialog (same as palette use).
     * executeCommand('msagent.parseLog', logPath?, { suppressMessage?: boolean })
     */
    const parseLogCmd = vscode.commands.registerCommand(
        'msagent.parseLog',
        async (
            logPath?: vscode.Uri | string,
            options?: { suppressMessage?: boolean },
        ): Promise<ParseResult | undefined> => {
            let fsPath = resolveLogInputToFsPath(logPath);
            if (!fsPath) {
                const uri = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectMany: false,
                    filters: { 'msAgent Logs': ['log', 'txt'], 'All Files': ['*'] },
                    title: 'Select msAgent Log File',
                });
                if (!uri?.[0]) {
                    return undefined;
                }
                fsPath = uri[0].fsPath;
            }
            if (!fs.existsSync(fsPath) || !fs.statSync(fsPath).isFile()) {
                if (!options?.suppressMessage) {
                    vscode.window.showErrorMessage(`msAgent: log file not found: ${fsPath}`);
                }
                return undefined;
            }
            return parseLogAtPathAndNotify(fsPath, options?.suppressMessage === true);
        },
    );

    /** Fix problem at index (0-based) from the last parse. executeCommand('msagent.fixProblem', index) */
    const fixProblemCmd = vscode.commands.registerCommand(
        'msagent.fixProblem',
        async (index: number | string | undefined): Promise<boolean> => {
            const idx = parseProblemIndex(index);
            if (idx === null) {
                vscode.window.showErrorMessage(
                    'msAgent: fixProblem requires a 0-based problem index (number or numeric string).',
                );
                return false;
            }
            return fixProblem(idx);
        },
    );

    const fixAllCmd = vscode.commands.registerCommand('msagent.fixAll', async (uri?: vscode.Uri) => {
        const fileUri = uri ? uri.toString() : vscode.window.activeTextEditor?.document.uri.toString();
        if (!fileUri) {
            vscode.window.showWarningMessage('No file open to fix. Open a file with msAgent diagnostics first.');
            return;
        }
        await fixAllDiagnostics(fileUri);
    });

    const fixDiagnosticCmd = vscode.commands.registerCommand('msagent.fixDiagnostic', async (uriStr: string, lineNumber: number) => {
        await fixDiagnostic(uriStr, lineNumber);
    });

    const clearDiagsCmd = vscode.commands.registerCommand('msagent.clearDiagnostics', () => {
        DiagnosticsManager.clearDiagnostics();
        vscode.window.showInformationMessage('msAgent diagnostics cleared.');
    });

    const openSettingsCmd = vscode.commands.registerCommand('msagent.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', 'msagent');
    });

    const testWebviewCmd = vscode.commands.registerCommand('msagent.testWebview', () => {
        const outputChannel = (global as any).msAgentOutputChannel;
        outputChannel?.appendLine('[TEST] testWebview command called');

        const context = (global as any).msAgentContext;
        if (!context) {
            outputChannel?.appendLine('[TEST] ERROR: No context');
            vscode.window.showErrorMessage('Extension context not available.');
            return;
        }

        outputChannel?.appendLine('[TEST] Importing WebviewPanelProvider...');
        import('./webview/webviewPanelProvider').then(({ WebviewPanelProvider }) => {
            const provider = new WebviewPanelProvider();
            outputChannel?.appendLine('[TEST] Provider created');

            outputChannel?.appendLine('[TEST] Calling createOrShow...');
            provider.createOrShow(context);

            outputChannel?.appendLine('[TEST] Sending test message...');
            const msgId = provider.nextMessageId();
            outputChannel?.appendLine('[TEST] Message ID: ' + msgId);

            provider.postMessage({
                type: 'text_stream',
                payload: {
                    messageId: msgId,
                    delta: '✅ Test message: WebView is working!\n\nIf you see this message, the webview communication is working correctly.\n'
                }
            });

            outputChannel?.appendLine('[TEST] Message sent');
            vscode.window.showInformationMessage('Test message sent to webview. Check Output → msAgent for logs.');
        }).catch(err => {
            outputChannel?.appendLine('[TEST] ERROR: ' + err.message);
            vscode.window.showErrorMessage('Failed to load WebviewPanelProvider: ' + err.message);
        });
    });

    context.subscriptions.push(
        parseLogCmd,
        fixProblemCmd,
        fixAllCmd,
        fixDiagnosticCmd,
        clearDiagsCmd,
        openSettingsCmd,
        testWebviewCmd,
        registerFixActions(context),
    );
}

async function validateLLMConfiguration(context: vscode.ExtensionContext): Promise<void> {
    const config = getLLMConfig();
    const dontAskAgain = context.globalState.get<boolean>('msagent.skipConfigValidation', false);
    if (dontAskAgain) {
        return;
    }

    try {
        const provider = new OpenAICompatProvider({
            endpoint: config.endpoint,
            modelName: config.modelName,
            timeoutMs: 30000,
        });

        await provider.chat(
            [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
            [],
        );
    } catch (error) {
        const action = await vscode.window.showWarningMessage(
            `msAgent: Cannot connect to LLM at ${config.endpoint}. Would you like to configure it now?`,
            'Configure',
            'Skip',
            "Don't Ask Again"
        );

        if (action === 'Configure') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'msagent');
        } else if (action === "Don't Ask Again") {
            context.globalState.update('msagent.skipConfigValidation', true);
        }
    }
}

export function deactivate() {
    if (outputChannel) {
        outputChannel.appendLine('msAgent extension deactivated');
    }
}

function parseProblemIndex(index: number | string | undefined): number | null {
    if (index === undefined || index === '') {
        return null;
    }
    const n = typeof index === 'number' ? index : Number(String(index).trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        return null;
    }
    return n;
}

function resolveLogInputToFsPath(uriOrPath: vscode.Uri | string | undefined): string | undefined {
    if (uriOrPath === undefined || uriOrPath === null) {
        return undefined;
    }
    if (uriOrPath instanceof vscode.Uri) {
        return uriOrPath.fsPath;
    }
    const s = String(uriOrPath).trim();
    if (!s) {
        return undefined;
    }
    if (path.isAbsolute(s)) {
        return s;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
        return undefined;
    }
    return path.normalize(path.join(folder, s));
}

function parseLogAtPathAndNotify(fsPath: string, suppressMessage?: boolean): ParseResult {
    const result = DiagnosticsManager.parseFileAndPublish(fsPath);
    if (!suppressMessage) {
        const count = result.diagnostics.length;
        const errors = result.diagnostics.filter((d) => d.severity === Severity.ERROR).length;
        const warnings = result.diagnostics.filter((d) => d.severity === Severity.WARNING).length;
        const message =
            count === 0
                ? 'No diagnostics found in log file.'
                : `Found ${count} diagnostics (${errors} errors, ${warnings} warnings)`;
        vscode.window.showInformationMessage(message);
    }
    return result;
}
