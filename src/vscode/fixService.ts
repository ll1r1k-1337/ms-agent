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
type FixProblemStatus =
    | 'completed'
    | 'stopped'
    | 'cancelled'
    | 'failed'
    | 'already_running'
    | 'invalid_index'
    | 'out_of_range';
export interface FixProblemResult {
    status: FixProblemStatus;
}
export interface FixProblemOptions {
    suppressProgressNotification?: boolean;
}
type QueuedFixTask = {
    id: string;
    key: string;
    sanitizerIndex: number;
    title: string;
    diagnostic: SanitizerDiagnostic;
    options?: FixProblemOptions;
    resolve: (result: FixProblemResult) => void;
};
const fixQueue: QueuedFixTask[] = [];
let isProcessingFixQueue = false;
let activeFixKey: string | undefined;
let activeSanitizerIndex: number | undefined;
let pauseRequested = false;
let cancelCurrentRequested = false;
let clearConversationOnIdleAfterCancel = false;
let currentCancellationTokenSource: vscode.CancellationTokenSource | undefined;
/** Title of the diagnostic currently being fixed (shifted off the queue). */
let activeFixTitle: string | undefined;
/** Task paused mid-run; kept out of fixQueue so the panel lists only not-yet-started work. */
let pausedActiveFixTask: QueuedFixTask | undefined;
/** Completed (successfully fixed) sanitizer indices in the current parsed-log session. */
const fixedSanitizerIndices = new Set<number>();

function logFixQueue(message: string): void {
    getOutputChannel().appendLine(`[QUEUE] ${message}`);
}

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

function getDiagnosticFixKey(diagnostic: SanitizerDiagnostic): string {
    return `${diagnostic.fileName}:${diagnostic.lineNumber}:${diagnostic.errorType}`;
}

function getDiagnosticTitle(diagnostic: SanitizerDiagnostic): string {
    const file = path.basename(diagnostic.fileName);
    return `${diagnostic.errorType} - ${file}:${diagnostic.lineNumber}`;
}

function createQueueTaskId(): string {
    return `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clearConversationIfCancelledAndIdle(): void {
    if (!clearConversationOnIdleAfterCancel) {
        return;
    }
    const noRunningTask = !currentCancellationTokenSource;
    const noPausedTask = !pausedActiveFixTask;
    const noQueuedTasks = fixQueue.length === 0;
    if (noRunningTask && noPausedTask && noQueuedTasks) {
        clearConversationOnIdleAfterCancel = false;
        webviewProvider.clear();
        notifyQueueState();
    }
}

function notifyQueueState(): void {
    const snapshot = getAiFixQueueSnapshot();
    logFixQueue(
        `notifyQueueState paused=${snapshot.paused} pending=${snapshot.hasPendingTasks} queued=${snapshot.items.length} active=${activeSanitizerIndex ?? 'none'} pausedActive=${pausedActiveFixTask?.sanitizerIndex ?? 'none'}`,
    );
    webviewProvider.postMessage({
        type: 'queue_state',
        payload: {
            paused: snapshot.paused,
            hasPendingTasks: snapshot.hasPendingTasks,
            items: snapshot.items,
        },
    });
}

export type SanitizerAiFixState = 'queued' | 'running' | 'fixed';
export interface AiFixQueueSnapshot {
    paused: boolean;
    hasPendingTasks: boolean;
    items: Array<{ id: string; title: string }>;
    states: Record<string, SanitizerAiFixState>;
}

function hasPendingFixTasks(): boolean {
    return (
        activeSanitizerIndex !== undefined
        || Boolean(currentCancellationTokenSource)
        || Boolean(pausedActiveFixTask)
        || fixQueue.length > 0
    );
}

export function getAiFixQueueSnapshot(): AiFixQueueSnapshot {
    const states: Record<string, SanitizerAiFixState> = {};
    for (const task of fixQueue) {
        states[String(task.sanitizerIndex)] = 'queued';
    }
    if (pausedActiveFixTask) {
        states[String(pausedActiveFixTask.sanitizerIndex)] = 'queued';
    }
    if (activeSanitizerIndex !== undefined) {
        states[String(activeSanitizerIndex)] = 'running';
    }
    for (const fixedIndex of fixedSanitizerIndices) {
        const key = String(fixedIndex);
        if (!states[key]) {
            states[key] = 'fixed';
        }
    }
    if (Object.keys(states).length > 0) {
        logFixQueue(`snapshot states=${JSON.stringify(states)}`);
    }
    return {
        paused: pauseRequested,
        hasPendingTasks: hasPendingFixTasks(),
        items: fixQueue.map((task) => ({ id: task.id, title: task.title })),
        states,
    };
}

/**
 * Per-row state for the sanitizer table (msAgentIndex matches fixProblem index).
 */
export function getAiFixQueueStates(): Record<string, SanitizerAiFixState> {
    return getAiFixQueueSnapshot().states;
}

export function resetAiFixHistory(): void {
    fixedSanitizerIndices.clear();
}

async function processFixQueue(): Promise<void> {
    if (isProcessingFixQueue) {
        return;
    }
    isProcessingFixQueue = true;
    try {
        for (;;) {
            if (pauseRequested) {
                break;
            }
            let next: QueuedFixTask | undefined;
            if (pausedActiveFixTask) {
                next = pausedActiveFixTask;
                pausedActiveFixTask = undefined;
            }
            else if (fixQueue.length > 0) {
                next = fixQueue.shift();
            }
            else {
                break;
            }
            if (!next) {
                break;
            }

            activeFixKey = next.key;
            activeSanitizerIndex = next.sanitizerIndex;
            activeFixTitle = next.title;
            currentCancellationTokenSource = new vscode.CancellationTokenSource();
            logFixQueue(`start task id=${next.id} index=${next.sanitizerIndex} key=${next.key}`);
            notifyQueueState();

            const result = await fixSingleDiagnostic(
                next.diagnostic,
                undefined,
                undefined,
                next.options,
                currentCancellationTokenSource,
            );

            const wasCancelled = cancelCurrentRequested;
            cancelCurrentRequested = false;

            if (result.status === 'stopped' && pauseRequested && !wasCancelled) {
                pausedActiveFixTask = next;
                logFixQueue(`pause task id=${next.id} index=${next.sanitizerIndex}`);
                currentCancellationTokenSource = undefined;
                activeFixKey = undefined;
                activeSanitizerIndex = undefined;
                activeFixTitle = undefined;
                notifyQueueState();
                break;
            }

            const finalStatus = wasCancelled ? 'cancelled' : result.status;
            if (finalStatus === 'completed') {
                fixedSanitizerIndices.add(next.sanitizerIndex);
            }
            next.resolve(wasCancelled ? { status: 'cancelled' } : result);
            logFixQueue(`finish task id=${next.id} index=${next.sanitizerIndex} status=${finalStatus}`);
            currentCancellationTokenSource = undefined;
            activeFixKey = undefined;
            activeSanitizerIndex = undefined;
            activeFixTitle = undefined;
            notifyQueueState();
            clearConversationIfCancelledAndIdle();
        }
    } finally {
        isProcessingFixQueue = false;
        currentCancellationTokenSource = undefined;
        activeFixKey = undefined;
        activeSanitizerIndex = undefined;
        activeFixTitle = undefined;
        notifyQueueState();
        clearConversationIfCancelledAndIdle();
    }
}

/**
 * Fix the problem at `index` (0-based) in the diagnostics list from the last `msagent.parseLog` (or any parse).
 */
export function showFixDetailsPanel(): void {
    ensureFixDetailsPanel();
    webviewProvider.revealLatestSession();
}

function ensureFixDetailsPanel(): void {
    const extensionContext = (global as any).msAgentContext as vscode.ExtensionContext | undefined;
    if (!extensionContext) {
        return;
    }
    webviewProvider.createOrShow(extensionContext);
    webviewProvider.onAction((message: { type?: string; id?: string }) => {
        if (message.type === 'pause_toggle') {
            if (pauseRequested) {
                pauseRequested = false;
                notifyQueueState();
                if (!isProcessingFixQueue && (pausedActiveFixTask || fixQueue.length > 0)) {
                    void processFixQueue();
                }
                return;
            }
            pauseRequested = true;
            cancelCurrentRequested = false;
            notifyQueueState();
            return;
        }
        if (message.type === 'cancel_current') {
            const hasQueuedAfterCurrent = fixQueue.length > 0;
            if (currentCancellationTokenSource) {
                cancelCurrentRequested = true;
                pauseRequested = false;
                clearConversationOnIdleAfterCancel = !hasQueuedAfterCurrent;
                currentCancellationTokenSource.cancel();
                notifyQueueState();
                return;
            }
            if (pausedActiveFixTask) {
                const task = pausedActiveFixTask;
                pausedActiveFixTask = undefined;
                task.resolve({ status: 'cancelled' });
                pauseRequested = false;
                cancelCurrentRequested = false;
                clearConversationOnIdleAfterCancel = !hasQueuedAfterCurrent;
                notifyQueueState();
                if (hasQueuedAfterCurrent) {
                    void processFixQueue();
                } else {
                    clearConversationIfCancelledAndIdle();
                }
                return;
            }
            clearConversationOnIdleAfterCancel = !hasQueuedAfterCurrent;
            notifyQueueState();
            clearConversationIfCancelledAndIdle();
            return;
        }
        if (message.type === 'remove_queued' && message.id) {
            const idx = fixQueue.findIndex((task) => task.id === message.id);
            if (idx >= 0) {
                const [removed] = fixQueue.splice(idx, 1);
                removed.resolve({ status: 'cancelled' });
                notifyQueueState();
            }
        }
    });
    notifyQueueState();
}

export async function fixProblem(
    index: number,
    options?: FixProblemOptions,
): Promise<FixProblemResult> {
    ensureFixDetailsPanel();
    if (!Number.isFinite(index) || index < 0 || !Number.isInteger(index)) {
        vscode.window.showWarningMessage(
            'msAgent: fixProblem requires a non-negative integer index (0-based).',
        );
        return { status: 'invalid_index' };
    }
    const all = DiagnosticsManager.getCurrentDiagnostics();
    if (index >= all.length) {
        const hint =
            all.length === 0
                ? 'Parse a log first (msagent.parseLog).'
                : `Valid index range: 0..${all.length - 1}.`;
        vscode.window.showWarningMessage(
            `msAgent: problem index ${index} is out of range. ${hint}`,
        );
        return { status: 'out_of_range' };
    }
    const diagnostic = all[index];
    const key = getDiagnosticFixKey(diagnostic);
    if (activeSanitizerIndex === index) {
        logFixQueue(`skip enqueue index=${index} reason=already_active_index`);
        webviewProvider.revealLatestSession();
        return { status: 'already_running' };
    }
    if (pausedActiveFixTask?.sanitizerIndex === index) {
        logFixQueue(`skip enqueue index=${index} reason=already_paused_index`);
        webviewProvider.revealLatestSession();
        return { status: 'already_running' };
    }
    if (fixQueue.some((task) => task.sanitizerIndex === index)) {
        logFixQueue(`skip enqueue index=${index} reason=already_queued_index`);
        webviewProvider.revealLatestSession();
        return { status: 'already_running' };
    }
    if (activeFixKey === key) {
        logFixQueue(
            `enqueue index=${index} while active key matches (activeIndex=${activeSanitizerIndex ?? 'none'})`,
        );
    }

    return new Promise<FixProblemResult>((resolve) => {
        const taskId = createQueueTaskId();
        logFixQueue(`enqueue task id=${taskId} index=${index} key=${key}`);
        fixedSanitizerIndices.delete(index);
        fixQueue.push({
            id: taskId,
            key,
            sanitizerIndex: index,
            title: getDiagnosticTitle(diagnostic),
            diagnostic,
            options,
            resolve,
        });
        notifyQueueState();
        void processFixQueue();
    });
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
    options?: FixProblemOptions,
    externalCancellationTokenSource?: vscode.CancellationTokenSource,
): Promise<FixProblemResult> {
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

    const cancellationTokenSource = externalCancellationTokenSource ?? new vscode.CancellationTokenSource();

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
            notifyQueueState();
        } else {
            outputChannel.appendLine('[DEBUG] ERROR: No extension context!');
        }

        const progressLocation = options?.suppressProgressNotification
            ? vscode.ProgressLocation.Window
            : vscode.ProgressLocation.Notification;
        const result = await vscode.window.withProgress(
            {
                location: progressLocation,
                title: progressTitle,
                cancellable: !options?.suppressProgressNotification,
            },
            async (progress, token) => {
                if (!options?.suppressProgressNotification) {
                    token.onCancellationRequested(() => {
                        cancellationTokenSource.cancel();
                    });
                }

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
                    abortSignal: { get aborted() { return cancellationTokenSource.token.isCancellationRequested; } },
                    pauseSignal: { get paused() { return pauseRequested; } },
                    useStreaming: true,

                    onMessageChunk: (chunk: StreamChunk, messageId: string) => {
                        if (cancellationTokenSource.token.isCancellationRequested) return;
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
                        if (cancellationTokenSource.token.isCancellationRequested) return;
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
                        if (cancellationTokenSource.token.isCancellationRequested) return;
                        webviewProvider.postMessage({
                            type: 'tool_result',
                            payload: { toolCallId, result, isError }
                        });
                    },

                    onDiff: (filePath, oldText, newText, toolCallId) => {
                        if (cancellationTokenSource.token.isCancellationRequested) return;
                        webviewProvider.postMessage({
                            type: 'diff',
                            payload: { path: filePath, oldText, newText, toolCallId }
                        });
                    },
                });

                if (!cancellationTokenSource.token.isCancellationRequested && agentResult) {
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
                } else if (cancellationTokenSource.token.isCancellationRequested) {
                    webviewProvider.postMessage({
                        type: 'error',
                        payload: { message: 'Fix stopped.' }
                    });
                }

                return agentResult;
            },
        );

        if (cancellationTokenSource.token.isCancellationRequested) {
            return { status: 'stopped' };
        }
        if (!result) {
            return { status: 'failed' };
        }
        return { status: 'completed' };
    } catch (e) {
        handleFixError(e, config);
        return { status: 'failed' };
    } finally {
        if (!externalCancellationTokenSource) {
            cancellationTokenSource.dispose();
        }
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