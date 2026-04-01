import * as vscode from 'vscode';
import { DiagnosticsManager } from './vscode/diagnosticsManager';
import { fixDiagnostic, fixAllDiagnostics } from './vscode/fixService';
import { registerFixActions } from './vscode/codeActionProvider';
import { OpenAICompatProvider } from './llm/openaiCompatProvider';
import { getLLMConfig } from './llm/config';
import { Severity } from './parser/types';

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

    const parseLogCmd = vscode.commands.registerCommand('msagent.parseLog', async () => {
        const uri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: { 'msAgent Logs': ['log', 'txt'], 'All Files': ['*'] },
            title: 'Select msAgent Log File',
        });
        if (uri && uri[0]) {
            const result = DiagnosticsManager.parseFileAndPublish(uri[0].fsPath);
            const count = result.diagnostics.length;
            const errors = result.diagnostics.filter(d => d.severity === Severity.ERROR).length;
            const warnings = result.diagnostics.filter(d => d.severity === Severity.WARNING).length;
            
            const message = count === 0
                ? 'No diagnostics found in log file.'
                : `Found ${count} diagnostics (${errors} errors, ${warnings} warnings)`;
            
            vscode.window.showInformationMessage(message);
        }
    });

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