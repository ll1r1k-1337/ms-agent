import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { runAgent, AgentResult } from '../agent/agentLoop';
import { DiagnosticsManager } from './diagnosticsManager';
import { OpenAICompatProvider } from '../llm/openaiCompatProvider';
import { LLMProvider } from '../llm/provider';
import { LLMProviderError } from '../llm/openaiCompatProvider';
import { getLLMConfig } from '../llm/config';
import { loadSkill } from '../skills/skillLoader';
import { buildFixPrompt } from '../skills/skillLoader';
import { ToolContext } from '../tools/toolHandlers';
import { SanitizerDiagnostic, Severity } from '../parser/types';
import { WebviewPanelProvider } from '../webview/webviewPanelProvider';
import { StreamChunk } from '../llm/types';

let outputChannel: vscode.OutputChannel | undefined;
const webviewProvider = new WebviewPanelProvider();

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        const globalChannel = (global as any).msAgentOutputChannel;
        if (globalChannel) {
            outputChannel = globalChannel;
        } else {
            outputChannel = vscode.window.createOutputChannel('msAgent');
        }
    }
    return outputChannel!;
}

/**
 * Resolve relative fileName from log to absolute path.
 * Searches in workspace root and last log directory.
 * Note: Diagnostics are already resolved during parsing, so this is mainly a safety fallback.
 */
function resolveFilePath(fileName: string, workspaceRoot: string): string {
    if (path.isAbsolute(fileName) && fs.existsSync(fileName)) {
        return fileName;
    }

    const searchDirs = [workspaceRoot, DiagnosticsManager.getLastLogDir() || workspaceRoot];
    for (const dir of searchDirs) {
        if (!dir) continue;
        const fullPath = path.join(dir, fileName);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }

    return path.join(workspaceRoot, fileName);
}

export async function fixDiagnostic(
    documentUri: string,
    lineNumber: number,
): Promise<void> {
    const diagnostics = DiagnosticsManager.getDiagnosticForFile(
        vscode.Uri.parse(documentUri).fsPath,
    );
    if (diagnostics.length === 0) {
        vscode.window.showWarningMessage('No msAgent diagnostics found for this file.');
        return;
    }

    const diagnostic = diagnostics.find(d =>
        Math.abs(d.lineNumber - (lineNumber + 1)) <= 2
    ) || diagnostics[0];

    await fixSingleDiagnostic(diagnostic);
}

export async function fixAllDiagnostics(
    documentUri: string,
): Promise<void> {
    const diagnostics = DiagnosticsManager.getDiagnosticForFile(
        vscode.Uri.parse(documentUri).fsPath,
    );
    if (diagnostics.length === 0) {
        vscode.window.showWarningMessage('No msAgent diagnostics found for this file.');
        return;
    }

    const errorDiags = diagnostics.filter(d => d.severity === Severity.ERROR);
    const fixSet = errorDiags.length > 0 ? errorDiags : diagnostics.slice(0, 1);

    const total = fixSet.length;
    let completed = 0;

    for (const diag of fixSet) {
        completed++;
        await fixSingleDiagnostic(diag, completed, total);
    }
}

async function fixSingleDiagnostic(
    diagnostic: SanitizerDiagnostic,
    current?: number,
    total?: number,
): Promise<void> {
    const config = getLLMConfig();
    const llm: LLMProvider = new OpenAICompatProvider({
        endpoint: config.endpoint,
        modelName: config.modelName,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
    });

    const workspaceRoot = vscode.workspace.rootPath || '.';
    const skillContent = loadSkill('memcheck-skills') || '';

    let prompt = buildFixPrompt(diagnostic);
    if (skillContent) {
        prompt += '\n\n## Additional Context\n' + skillContent;
    }

    const toolContext: ToolContext = {
        workspaceRoot,
        diagnostics: diagnostic,
    };

    const progressTitle = total && current
        ? `msAgent: Fixing ${diagnostic.errorType} (${current}/${total})`
        : `msAgent: Fixing ${diagnostic.errorType}`;

    const cancellationTokenSource = new vscode.CancellationTokenSource();

    try {
        const extensionContext = (global as any).msAgentContext as vscode.ExtensionContext;
        const outputChannel = getOutputChannel();
        
        outputChannel.appendLine('[DEBUG] ========== fixDiagnostic called ==========');
        outputChannel.appendLine('[DEBUG] Diagnostic: ' + diagnostic.errorType + ' at ' + diagnostic.fileName + ':' + diagnostic.lineNumber);
        outputChannel.appendLine('[DEBUG] Extension context exists: ' + !!extensionContext);
        
        if (extensionContext) {
            outputChannel.appendLine('[DEBUG] Creating/showing webview...');
            webviewProvider.createOrShow(extensionContext);
            webviewProvider.clear();
            webviewProvider.onStop(() => {
                cancellationTokenSource.cancel();
            });
        } else {
            outputChannel.appendLine('[DEBUG] ERROR: No extension context!');
        }

        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: progressTitle,
                cancellable: true,
            },
            async (progress, token) => {
                token.onCancellationRequested(() => {
                    cancellationTokenSource.cancel();
                });

                progress.report({ message: 'Analyzing error...', increment: 0 });

                const resolvedPath = resolveFilePath(diagnostic.fileName, workspaceRoot);
                const originalContent = fs.existsSync(resolvedPath) 
                    ? fs.readFileSync(resolvedPath, 'utf-8') 
                    : '';

                const taskId = webviewProvider.nextMessageId();
                outputChannel.appendLine('[DEBUG] Task ID: ' + taskId);
                outputChannel.appendLine('[DEBUG] Sending task info to webview...');
                
                webviewProvider.postMessage({
                    type: 'text_stream',
                    payload: { 
                        messageId: taskId,
                        delta: '📝 Task: Fix ' + diagnostic.errorType + ' at line ' + diagnostic.lineNumber + '\n'
                    }
                });

                webviewProvider.postMessage({
                    type: 'text_stream',
                    payload: { 
                        messageId: taskId,
                        delta: 'File: ' + path.basename(diagnostic.fileName) + '\n\n'
                    }
                });

                outputChannel.appendLine('[DEBUG] Starting runAgent...');
                const agentResult = await runAgent({
                    systemPrompt: 'You are a memory error fix specialist for Ascend NPU operators. Read the source file, understand the error, and apply a minimal fix. Use the edit_file tool to make changes.',
                    taskDescription: prompt,
                    toolContext,
                    llm,
                    maxToolRounds: 10,
                    abortSignal: { get aborted() { return token.isCancellationRequested; } },
                    useStreaming: true,

                    onMessageChunk: (chunk: StreamChunk, messageId: string) => {
                        if (token.isCancellationRequested) return;
                        outputChannel.appendLine('[DEBUG] onMessageChunk: type=' + chunk.type + ' delta=' + (chunk.delta?.substring(0, 30) || 'null'));
                        if (chunk.type === 'text_delta' && chunk.delta) {
                            outputChannel.appendLine('[DEBUG] Sending to webview: text_stream');
                            webviewProvider.postMessage({
                                type: 'text_stream',
                                payload: { messageId, delta: chunk.delta }
                            });
                        }
                    },

                    onToolCall: (name, params, toolCallId) => {
                        if (token.isCancellationRequested) return;
                        progress.report({
                            message: `${name}(${Object.keys(params).join(', ')})`,
                            increment: 10,
                        });
                        webviewProvider.postMessage({
                            type: 'tool_call',
                            payload: {
                                messageId: webviewProvider.nextMessageId(),
                                toolCallId,
                                name,
                                params
                            }
                        });
                    },

                    onToolResult: (toolCallId, result, isError) => {
                        if (token.isCancellationRequested) return;
                        webviewProvider.postMessage({
                            type: 'tool_result',
                            payload: { toolCallId, result, isError }
                        });
                    },

                    onDiff: (filePath, oldText, newText, toolCallId) => {
                        if (token.isCancellationRequested) return;
                        webviewProvider.postMessage({
                            type: 'diff',
                            payload: { path: filePath, oldText, newText, toolCallId }
                        });
                    },
                });

                if (!token.isCancellationRequested && agentResult) {
                    if (fs.existsSync(resolvedPath)) {
                        const newContent = fs.readFileSync(resolvedPath, 'utf-8');
                        const outputChannel = getOutputChannel();
                        outputChannel.appendLine(`[DEBUG] Original length: ${originalContent.length}, New length: ${newContent.length}`);
                        outputChannel.appendLine(`[DEBUG] Files differ: ${originalContent !== newContent}`);
                        
                        if (originalContent !== newContent) {
                            outputChannel.appendLine(`[DEBUG] Sending final_diff message`);
                            webviewProvider.postMessage({
                                type: 'final_diff',
                                payload: { 
                                    path: resolvedPath,
                                    oldContent: originalContent,
                                    newContent: newContent,
                                    message: agentResult.finalMessage 
                                }
                            });
                        } else {
                            outputChannel.appendLine(`[DEBUG] No changes detected`);
                            webviewProvider.postMessage({
                                type: 'error',
                                payload: { message: 'No changes were made to the file. The LLM may not have called edit_file correctly.' }
                            });
                        }
                    } else {
                        webviewProvider.postMessage({
                            type: 'error',
                            payload: { message: `File not found: ${resolvedPath}` }
                        });
                    }
                    webviewProvider.postMessage({
                        type: 'message_complete',
                        payload: { messageId: webviewProvider.nextMessageId() }
                    });
                }

                return agentResult;
            },
        );

        if (!result) {
            return;
        }
    } catch (e) {
        handleFixError(e, config);
    } finally {
        cancellationTokenSource.dispose();
    }
}

function showFixDetails(diagnostic: SanitizerDiagnostic, result: AgentResult) {
    const channel = getOutputChannel();
    const workspaceRoot = vscode.workspace.rootPath || '.';
    const resolvedPath = resolveFilePath(diagnostic.fileName, workspaceRoot);
    channel.clear();
    channel.appendLine(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    channel.appendLine(`Fix Applied: ${diagnostic.errorType}`);
    channel.appendLine(`File: ${resolvedPath}:${diagnostic.lineNumber}`);
    channel.appendLine(`Tool Calls: ${result.toolCallCount}`);
    channel.appendLine(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    channel.appendLine('');
    channel.appendLine('Agent Response:');
    channel.appendLine(result.finalMessage);
    channel.appendLine('');
    channel.appendLine('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    channel.show(true);
}

function handleFixError(e: unknown, config: ReturnType<typeof getLLMConfig>) {
    if (e instanceof LLMProviderError) {
        let friendly = '❌ msAgent fix failed\n\n';
        switch (e.code) {
            case 'CONNECTION_REFUSED':
                friendly += `Cannot connect to LLM at ${config.endpoint}.\n\n`;
                friendly += 'Please ensure:\n';
                friendly += '• Ollama is running: `ollama serve`\n';
                friendly += '• Model is pulled: `ollama pull qwen3:8b`\n';
                friendly += '• Endpoint is correct in settings';
                break;
            case 'TIMEOUT':
                friendly += 'LLM request timed out.\n\n';
                friendly += 'Suggestions:\n';
                friendly += '• Use a smaller model (qwen3:8b instead of 30b)\n';
                friendly += '• Increase timeoutMs setting (current: ' + config.timeoutMs + 'ms)\n';
                friendly += '• Simplify the fix by fixing one error at a time\n';
                friendly += '• Check system resources (CPU/memory utilization)';
                break;
            case 'HTTP_ERROR':
                friendly += `LLM returned HTTP error:\n${e.message}`;
                break;
            case 'INVALID_RESPONSE':
                friendly += 'LLM returned an invalid response.\n\n';
                friendly += 'Try a different model or check model compatibility.';
                break;
            default:
                friendly += e.message;
        }
        vscode.window.showErrorMessage(friendly, 'Open Settings').then(action => {
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'msagent');
            }
        });
    } else {
        const message = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`msAgent fix failed: ${message}`);
    }
}