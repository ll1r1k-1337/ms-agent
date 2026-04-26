import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { DiagnosticsManager } from './diagnosticsManager';
import { getLLMConfig } from '../llm/config';
import { SanitizerDiagnostic, Severity } from '../parser/types';
import { WebviewPanelProvider } from '../webview/webviewPanelProvider';
import { StreamChunk } from '../llm/types';
import { createFixBackend, FixCallbacks, FixResult } from '../backends/backendFactory';

export const _deps = { existsSync: fs.existsSync };
export function _setTestDeps(deps: Partial<typeof _deps>) { Object.assign(_deps, deps); }
export function _resetTestDeps() { _deps.existsSync = fs.existsSync; }

let outputChannel: vscode.OutputChannel | undefined;
const webviewProvider = new WebviewPanelProvider();
type FixProblemStatus =
    | 'completed'
    | 'no_change'
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
    clearWebview?: boolean;
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
export function resolveFilePath(fileName: string, workspaceRoot: string): string {
    if (path.isAbsolute(fileName) && _deps.existsSync(fileName)) {
        return fileName;
    }

    const searchDirs = [workspaceRoot, DiagnosticsManager.getLastLogDir() || workspaceRoot];
    for (const dir of searchDirs) {
        if (!dir) continue;
        const fullPath = path.join(dir, fileName);
        if (_deps.existsSync(fullPath)) {
            return fullPath;
        }
    }

    return path.join(workspaceRoot, fileName);
}

export function getDiagnosticFixKey(diagnostic: SanitizerDiagnostic): string {
    return `${diagnostic.fileName}:${diagnostic.lineNumber}:${diagnostic.errorType}`;
}

export function getDiagnosticTitle(diagnostic: SanitizerDiagnostic): string {
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
                next.options?.clearWebview,
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

    const all = DiagnosticsManager.getCurrentDiagnostics();
    const promises: Promise<FixProblemResult>[] = [];

    for (let i = 0; i < fixSet.length; i++) {
        const diag = fixSet[i];
        const index = all.indexOf(diag);
        if (index >= 0) {
            promises.push(fixProblem(index, { clearWebview: i === 0 }));
        }
    }

    const results = await Promise.all(promises);
    const anyFailed = results.some(r => r.status === 'failed');
    if (anyFailed) {
        vscode.window.showWarningMessage(
            'Some fixes failed. Check the msAgent output panel for details.'
        );
    }
}

async function fixSingleDiagnostic(
    diagnostic: SanitizerDiagnostic,
    current?: number,
    total?: number,
    options?: FixProblemOptions,
    externalCancellationTokenSource?: vscode.CancellationTokenSource,
    clearWebview: boolean = true,
): Promise<FixProblemResult> {
    const config = getLLMConfig();
    const backend = createFixBackend(config);
    const workspaceRoot = vscode.workspace.rootPath || '.';

    const progressTitle = total && current
        ? `msAgent: Fixing ${diagnostic.errorType} (${current}/${total})`
        : `msAgent: Fixing ${diagnostic.errorType}`;

    const cancellationTokenSource = externalCancellationTokenSource ?? new vscode.CancellationTokenSource();

    cancellationTokenSource.token.onCancellationRequested(() => {
        backend.cancel();
    });

    try {
        const extensionContext = (global as any).msAgentContext as vscode.ExtensionContext;

        // Always create the webview — it is the primary UI for fix progress,
        // diffs, and errors.
        if (extensionContext) {
            webviewProvider.createOrShow(extensionContext);
            if (clearWebview) {
                webviewProvider.clear();
            }
            notifyQueueState();
        }

        // Use window progress (status bar) instead of notification popup
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: progressTitle,
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: 'Analyzing error...', increment: 0 });

                const resolvedPath = resolveFilePath(diagnostic.fileName, workspaceRoot);
                const originalContent = fs.existsSync(resolvedPath) 
                    ? fs.readFileSync(resolvedPath, 'utf-8') 
                    : '';

                const taskId = webviewProvider.nextMessageId();

                // Show the user prompt in the webview as a user message bubble
                const userMessageId = webviewProvider.nextMessageId();
                const userPromptSummary =
                    '📝 Fix ' + diagnostic.errorType +
                    ' at ' + path.basename(diagnostic.fileName) + ':' + diagnostic.lineNumber +
                    (diagnostic.kernelName ? ' (kernel: ' + diagnostic.kernelName + ')' : '');
                webviewProvider.postMessage({
                    type: 'user_message',
                    payload: {
                        messageId: userMessageId,
                        text: userPromptSummary,
                    },
                });

                // Also stream the task info as assistant context
                webviewProvider.postMessage({
                    type: 'text_stream',
                    payload: {
                        messageId: taskId,
                        delta: 'Analyzing ' + diagnostic.errorType + ' at line ' + diagnostic.lineNumber + '...\n'
                    }
                });

                const activeMessageIds = new Set<string>();
                activeMessageIds.add(taskId);
                const callbacks: FixCallbacks = {
                    onMessageChunk: (chunk: StreamChunk, messageId: string) => {
                        if (cancellationTokenSource.token.isCancellationRequested) return;
                        if (chunk.type === 'text_delta' && chunk.delta) {
                            activeMessageIds.add(messageId);
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
                    onEvent: (type: string, payload: unknown) => {
                        if (cancellationTokenSource.token.isCancellationRequested) return;
                        switch (type) {
                            case 'session_start':
                                webviewProvider.postMessage({
                                    type: 'session_start',
                                    payload: payload as { backend: string; mode?: string; model?: string },
                                });
                                break;
                            case 'session_metadata':
                                webviewProvider.postMessage({
                                    type: 'session_metadata',
                                    payload: payload as { opencodeSessionId?: string },
                                });
                                break;
                            case 'session_end':
                                webviewProvider.postMessage({
                                    type: 'session_end',
                                    payload: payload as { success: boolean; outcome: 'applied' | 'no_change' | 'failed'; finalMessage: string },
                                });
                                break;
                            case 'status':
                                webviewProvider.postMessage({
                                    type: 'status',
                                    payload: payload as { phase: string; message?: string },
                                });
                                break;
                            case 'backend_info':
                                webviewProvider.postMessage({
                                    type: 'backend_info',
                                    payload: payload as { backend: string; mode: string; model?: string },
                                });
                                break;
                            case 'step_update':
                                webviewProvider.postMessage({
                                    type: 'step_update',
                                    payload: payload as { step: string; detail?: string },
                                });
                                break;
                            default:
                                break;
                        }
                    },
                };

                webviewProvider.postMessage({
                    type: 'backend_info',
                    payload: {
                        backend: backend.name,
                        mode: config.opencodeMode,
                        model: config.modelFullName,
                    },
                });

                let fixResult: FixResult;
                try {
                    fixResult = await backend.executeFix(
                        diagnostic,
                        { workspaceRoot, extensionContext },
                        callbacks,
                    );

                    // Note: session_end is already sent by the session via onEvent callback.
                    // Only send final_diff here; don't send session_end again.
                    if (
                        !cancellationTokenSource.token.isCancellationRequested
                        && fixResult.outcome === 'applied'
                        && fixResult.success
                        && fixResult.fileChanged
                        && fixResult.originalContent !== undefined
                        && fixResult.newContent !== undefined
                    ) {
                        webviewProvider.postMessage({
                            type: 'final_diff',
                            payload: {
                                path: resolvedPath,
                                oldContent: fixResult.originalContent,
                                newContent: fixResult.newContent,
                                message: fixResult.finalMessage
                            }
                        });
                    }
                } finally {
                    for (const msgId of activeMessageIds) {
                        webviewProvider.postMessage({
                            type: 'message_complete',
                            payload: { messageId: msgId }
                        });
                    }
                }

                return fixResult!;
            },
        );

        if (cancellationTokenSource.token.isCancellationRequested) {
            return { status: 'stopped' };
        }
        if (result.outcome === 'no_change') {
            return { status: 'no_change' };
        }
        if (!result.success) {
            return { status: 'failed' };
        }
        return { status: 'completed' };
    } catch (e) {
        // Session already sends session_end via onEvent callback on error.
        // Just show the VSCode error notification here.
        handleFixError(e, config);
        return { status: 'failed' };
    } finally {
        if (!externalCancellationTokenSource) {
            cancellationTokenSource.dispose();
        }
    }
}

function formatOpenCodeConnectionError(
    message: string,
    config: ReturnType<typeof getLLMConfig>,
): string {
    const mode = config.opencodeMode;
    let friendly = '❌ msAgent fix failed\n\n';
    friendly += `OpenCode ${mode} mode failed.\n\n`;
    friendly += 'Current configuration:\n';
    friendly += `• CLI path: ${config.opencodeCliPath}\n`;
    if (mode === 'server') {
        friendly += `• Server port: ${config.opencodeServePort}\n`;
    } else {
        friendly += `• ACP args: ${config.opencodeAcpArgs.join(' ')}\n`;
    }
    friendly += '\n';
    friendly += 'Underlying error:\n';
    friendly += `${message}\n\n`;
    friendly += 'Please ensure:\n';
    friendly += '• OpenCode is installed and available in your PATH\n';
    if (mode === 'server') {
        friendly += `• If using server mode, start OpenCode with \`opencode serve --port ${config.opencodeServePort}\`\n`;
    } else {
        friendly += `• If using ACP mode, verify \`${config.opencodeCliPath} ${config.opencodeAcpArgs.join(' ')}\` works in the same environment as VS Code\n`;
    }
    friendly += '• Review the msAgent settings if the CLI path, mode, or timeout changed';
    return friendly;
}

function handleFixError(e: unknown, config: ReturnType<typeof getLLMConfig>) {
    const message = e instanceof Error ? e.message : String(e);
    if (
        message.includes('Transport error')
        || message.includes('ECONNREFUSED')
        || message.includes('request error')
        || message.includes('response error')
        || message.includes('OpenCode CLI not found')
    ) {
        const friendly = formatOpenCodeConnectionError(message, config);
        vscode.window.showErrorMessage(friendly, 'Open Settings').then((action) => {
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'msagent');
            }
        });
        return;
    }

    vscode.window.showErrorMessage(`msAgent fix failed: ${message}`);
}

// For tests only
export function _resetFixState() {
    fixQueue.length = 0;
    isProcessingFixQueue = false;
    activeFixKey = undefined;
    activeSanitizerIndex = undefined;
    pauseRequested = false;
    cancelCurrentRequested = false;
    clearConversationOnIdleAfterCancel = false;
    currentCancellationTokenSource = undefined;
    activeFixTitle = undefined;
    pausedActiveFixTask = undefined;
    fixedSanitizerIndices.clear();
}

export function _enqueueFixTask(task: Omit<QueuedFixTask, 'id'> & { id?: string }) {
    fixQueue.push({ ...task, id: task.id || `test_${Math.random()}` });
}

export function _setActiveFix(index: number, title?: string) {
    activeSanitizerIndex = index;
    activeFixTitle = title;
}

export function _setPausedFix(task: QueuedFixTask | undefined) {
    pausedActiveFixTask = task;
}

export function _setPauseRequested(v: boolean) {
    pauseRequested = v;
}

export function _addFixedIndex(index: number) {
    fixedSanitizerIndices.add(index);
}
