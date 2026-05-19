import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { DiagnosticsManager } from './diagnosticsManager';
import { getLLMConfig } from '../llm/config';
import { SanitizerDiagnostic, Severity } from '../parser/types';
import {
    normalizeFixIssueRequest,
    repairIssueFromSanitizerDiagnostic,
} from './repairIssue';
import type { RepairIssue } from './repairIssue';
import { WebviewPanelProvider, MSAGENT_FIX_VIEW_TYPE } from '../webview/webviewPanelProvider';
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
    | 'invalid_payload'
    | 'invalid_index'
    | 'out_of_range';
export interface FixProblemResult {
    status: FixProblemStatus;
    removedDiagnostic?: boolean;
}
export interface FixProblemOptions {
    suppressProgressNotification?: boolean;
    clearWebview?: boolean;
}
/**
 * Metadata attached to every task that belongs to a single `fixIssues` batch.
 * Carrying this on the task keeps progress reporting, snapshot display, and
 * batch cancellation working through the existing single-task queue without
 * splitting the queueing path into two code paths.
 */
export type FixBatchTaskMeta = {
    batchId: string;
    batchIndex: number;
    batchTotal: number;
};
type QueuedFixTask = {
    id: string;
    key: string;
    sanitizerIndex?: number;
    title: string;
    issue: RepairIssue;
    sourceDiagnostic?: SanitizerDiagnostic;
    options?: FixProblemOptions;
    batchMeta?: FixBatchTaskMeta;
    resolve: (result: FixProblemResult) => void;
};
const fixQueue: QueuedFixTask[] = [];

/**
 * Per-task runtime state for a fix currently being processed by a worker.
 * Stored in `activeTasks` so multiple fixes can run concurrently.
 */
interface ActiveTaskEntry {
    task: QueuedFixTask;
    cts: vscode.CancellationTokenSource;
}

/** Tasks currently being processed by a worker, keyed by `task.id`. */
const activeTasks = new Map<string, ActiveTaskEntry>();
/** Number of worker loops currently alive (active + about-to-pull-a-task). */
let activeWorkerCount = 0;
/** Tasks that were paused mid-run; kept out of `fixQueue` so the panel lists only not-yet-started work. */
const pausedActiveFixTasks = new Map<string, QueuedFixTask>();
/** Task ids the user has explicitly asked to cancel; cleared once the worker observes the request. */
const cancelRequestedTaskIds = new Set<string>();
let pauseRequested = false;
let clearConversationOnIdleAfterCancel = false;
/** Completed (successfully fixed) sanitizer indices in the current parsed-log session. */
const fixedSanitizerIndices = new Set<number>();

function isKeyActive(key: string): boolean {
    for (const entry of activeTasks.values()) {
        if (entry.task.key === key) return true;
    }
    return false;
}

function isKeyPaused(key: string): boolean {
    for (const task of pausedActiveFixTasks.values()) {
        if (task.key === key) return true;
    }
    return false;
}

function isSanitizerIndexActive(index: number): boolean {
    for (const entry of activeTasks.values()) {
        if (entry.task.sanitizerIndex === index) return true;
    }
    return false;
}

function isSanitizerIndexPaused(index: number): boolean {
    for (const task of pausedActiveFixTasks.values()) {
        if (task.sanitizerIndex === index) return true;
    }
    return false;
}

function logFixQueue(message: string): void {
    getOutputChannel().appendLine(`[QUEUE] ${message}`);
}

function logFixResult(
    outcome: 'applied' | 'no_change' | 'failed',
    finalMessage: string,
    explanationKind?: 'structured' | 'synthetic' | 'plain' | 'missing',
): void {
    const normalizedMessage = String(finalMessage || '')
        .replace(/\s+/g, ' ')
        .trim();
    const kind = explanationKind ?? 'none';
    getOutputChannel().appendLine(
        `[FIX] session_end outcome=${outcome} explanationKind=${kind} message=${normalizedMessage || '(empty)'}`,
    );
}

function logFix(message: string): void {
    getOutputChannel().appendLine(`[FIX] ${message}`);
}

function formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    const remMs = ms % 1000;
    if (seconds < 60) return `${seconds}.${String(remMs).padStart(3, '0')}s`;
    const minutes = Math.floor(seconds / 60);
    const remSec = seconds % 60;
    return `${minutes}m${String(remSec).padStart(2, '0')}s`;
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

export function getDiagnosticFixKey(diagnostic: SanitizerDiagnostic | RepairIssue): string {
    return `${diagnostic.fileName}:${diagnostic.lineNumber}:${diagnostic.errorType}`;
}

export function getDiagnosticTitle(diagnostic: SanitizerDiagnostic | RepairIssue): string {
    const file = path.basename(diagnostic.fileName);
    return `${diagnostic.errorType} - ${file}:${diagnostic.lineNumber}`;
}

function createQueueTaskId(): string {
    return `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createFixRunId(): string {
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Number of fix tasks the queue is allowed to process concurrently.
 * Reads `msagent.fixesPerBatch` from VS Code settings, clamped to [1, 10] so
 * a misconfigured value (or a missing setting) always yields safe behavior.
 */
export function readFixesPerBatch(): number {
    try {
        const raw = vscode.workspace
            .getConfiguration('msagent')
            .get<number>('fixesPerBatch', 1);
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
            return 1;
        }
        const rounded = Math.floor(raw);
        if (rounded < 1) return 1;
        if (rounded > 10) return 10;
        return rounded;
    } catch {
        return 1;
    }
}

function clearConversationIfCancelledAndIdle(): void {
    if (!clearConversationOnIdleAfterCancel) {
        return;
    }
    if (activeTasks.size === 0 && pausedActiveFixTasks.size === 0 && fixQueue.length === 0) {
        clearConversationOnIdleAfterCancel = false;
        webviewProvider.clear();
        notifyQueueState();
    }
}

function describeActiveIndices(): string {
    const indices: string[] = [];
    for (const entry of activeTasks.values()) {
        indices.push(String(entry.task.sanitizerIndex ?? 'direct'));
    }
    return indices.length === 0 ? 'none' : indices.join(',');
}

function describePausedIndices(): string {
    const indices: string[] = [];
    for (const task of pausedActiveFixTasks.values()) {
        indices.push(String(task.sanitizerIndex ?? 'direct'));
    }
    return indices.length === 0 ? 'none' : indices.join(',');
}

function notifyQueueState(): void {
    const snapshot = getAiFixQueueSnapshot();
    logFixQueue(
        `notifyQueueState paused=${snapshot.paused} pending=${snapshot.hasPendingTasks}`
        + ` queued=${snapshot.items.length} active=${describeActiveIndices()}`
        + ` pausedActive=${describePausedIndices()}`,
    );
    webviewProvider.postMessage({
        type: 'queue_state',
        payload: {
            paused: snapshot.paused,
            hasPendingTasks: snapshot.hasPendingTasks,
            items: snapshot.items,
            runningTasks: snapshot.runningTasks,
            recentlyCompleted: snapshot.recentlyCompleted,
        },
    });
}

export type SanitizerAiFixState = 'queued' | 'running' | 'fixed';

/** Terminal status the worker stamped on a task when it finished. */
export type CompletedTaskStatus =
    | 'completed'
    | 'no_change'
    | 'failed'
    | 'cancelled'
    | 'stopped';

export interface AiFixQueueSnapshotItem {
    id: string;
    title: string;
    /** Present only for tasks enqueued by `fixIssues` so callers can group them. */
    batchId?: string;
    /** Zero-based slot of this task inside its batch. */
    batchIndex?: number;
    /** Total tasks originally enqueued in this batch. */
    batchTotal?: number;
}

export interface AiFixCompletedSnapshotItem extends AiFixQueueSnapshotItem {
    status: CompletedTaskStatus;
    /** Unix-ms timestamp of when the worker recorded the completion. */
    completedAt: number;
}

export interface AiFixQueueSnapshot {
    paused: boolean;
    hasPendingTasks: boolean;
    items: AiFixQueueSnapshotItem[];
    /** Tasks currently being processed by a worker (size ≤ `msagent.fixesPerBatch`). */
    runningTasks: AiFixQueueSnapshotItem[];
    /**
     * Recent task completions in newest-first order. Reset when the WebView
     * is cleared (e.g. when a new fix run starts with `clearWebview: true`).
     * Capped to the last `MAX_RECENTLY_COMPLETED` entries.
     */
    recentlyCompleted: AiFixCompletedSnapshotItem[];
    states: Record<string, SanitizerAiFixState>;
    /** Active batch identifier when the currently running task belongs to a batch. */
    activeBatchId?: string;
}

const MAX_RECENTLY_COMPLETED = 100;
const recentlyCompletedTasks: AiFixCompletedSnapshotItem[] = [];

function describeTaskForSnapshot(task: QueuedFixTask): AiFixQueueSnapshotItem {
    return {
        id: task.id,
        title: task.title,
        ...(task.batchMeta
            ? {
                batchId: task.batchMeta.batchId,
                batchIndex: task.batchMeta.batchIndex,
                batchTotal: task.batchMeta.batchTotal,
            }
            : {}),
    };
}

function recordCompletedTask(task: QueuedFixTask, status: CompletedTaskStatus): void {
    recentlyCompletedTasks.unshift({
        ...describeTaskForSnapshot(task),
        status,
        completedAt: Date.now(),
    });
    if (recentlyCompletedTasks.length > MAX_RECENTLY_COMPLETED) {
        recentlyCompletedTasks.length = MAX_RECENTLY_COMPLETED;
    }
}

function resetCompletedHistory(): void {
    recentlyCompletedTasks.length = 0;
}

function hasPendingFixTasks(): boolean {
    return (
        activeTasks.size > 0
        || pausedActiveFixTasks.size > 0
        || fixQueue.length > 0
    );
}

export function getAiFixQueueSnapshot(): AiFixQueueSnapshot {
    const states: Record<string, SanitizerAiFixState> = {};
    for (const task of fixQueue) {
        if (task.sanitizerIndex !== undefined) {
            states[String(task.sanitizerIndex)] = 'queued';
        }
    }
    for (const task of pausedActiveFixTasks.values()) {
        if (task.sanitizerIndex !== undefined) {
            states[String(task.sanitizerIndex)] = 'queued';
        }
    }
    for (const entry of activeTasks.values()) {
        if (entry.task.sanitizerIndex !== undefined) {
            states[String(entry.task.sanitizerIndex)] = 'running';
        }
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
    // Surface the *first* active batch id for backward-compat; with N>1
    // concurrency multiple batches could in principle have active tasks at
    // once, but the consumer only uses this for "is the WebView showing a
    // batch session" — picking the first deterministic one is fine.
    let activeBatchId: string | undefined;
    for (const entry of activeTasks.values()) {
        if (entry.task.batchMeta) {
            activeBatchId = entry.task.batchMeta.batchId;
            break;
        }
    }
    const runningTasksSnapshot: AiFixQueueSnapshotItem[] = [];
    for (const entry of activeTasks.values()) {
        runningTasksSnapshot.push(describeTaskForSnapshot(entry.task));
    }
    return {
        paused: pauseRequested,
        hasPendingTasks: hasPendingFixTasks(),
        items: fixQueue.map(describeTaskForSnapshot),
        runningTasks: runningTasksSnapshot,
        recentlyCompleted: recentlyCompletedTasks.slice(),
        states,
        ...(activeBatchId ? { activeBatchId } : {}),
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

export interface CancelBatchResult {
    /** Total tasks for this batch that were transitioned to `cancelled`. */
    cancelled: number;
    /** Of those, how many were waiting in the queue (never started). */
    queued: number;
    /** Of those, how many were paused mid-run. */
    paused: number;
    /** Of those, how many were actively running and got their CTS cancelled. */
    running: number;
}

/**
 * Cancel every task belonging to `batchId`, regardless of whether it is
 * currently queued, paused, or actively running. The corresponding fixIssues
 * promise resolves once the running tasks observe the cancellation and unwind
 * — this function only kicks the cancellations off and returns synchronously
 * so command callers don't have to wait.
 */
export function cancelBatch(batchId: string): CancelBatchResult {
    if (!batchId || typeof batchId !== 'string') {
        return { cancelled: 0, queued: 0, paused: 0, running: 0 };
    }
    let queued = 0;
    let paused = 0;
    let running = 0;
    // 1. Remove any not-yet-started tasks from the queue (iterate backwards so
    //    splice indices stay valid).
    for (let i = fixQueue.length - 1; i >= 0; i -= 1) {
        const task = fixQueue[i];
        if (task.batchMeta?.batchId === batchId) {
            fixQueue.splice(i, 1);
            task.resolve({ status: 'cancelled' });
            queued += 1;
        }
    }
    // 2. Drop paused tasks owned by this batch.
    for (const [id, task] of Array.from(pausedActiveFixTasks.entries())) {
        if (task.batchMeta?.batchId === batchId) {
            pausedActiveFixTasks.delete(id);
            task.resolve({ status: 'cancelled' });
            paused += 1;
        }
    }
    // 3. Mark every running task in the batch as user-cancelled and cancel
    //    its CancellationTokenSource so the backend tears down promptly.
    for (const [id, entry] of activeTasks.entries()) {
        if (entry.task.batchMeta?.batchId === batchId) {
            cancelRequestedTaskIds.add(id);
            entry.cts.cancel();
            running += 1;
        }
    }
    const total = queued + paused + running;
    logFixQueue(
        `cancelBatch id=${batchId} cancelled=${total} queued=${queued} paused=${paused} running=${running}`,
    );
    if (total > 0) {
        notifyQueueState();
    }
    return { cancelled: total, queued, paused, running };
}

/**
 * Spin up additional worker loops if the queue has work and the active worker
 * count is below `msagent.fixesPerBatch`. Safe to call repeatedly — workers
 * exit on their own when the queue drains.
 */
function startProcessing(): void {
    if (pauseRequested) {
        return;
    }
    const concurrency = readFixesPerBatch();
    while (activeWorkerCount < concurrency) {
        const hasResumableWork = pausedActiveFixTasks.size > 0 || fixQueue.length > 0;
        if (!hasResumableWork) {
            break;
        }
        activeWorkerCount += 1;
        void runFixWorker();
    }
}

async function runFixWorker(): Promise<void> {
    try {
        for (;;) {
            if (pauseRequested) {
                return;
            }
            let next: QueuedFixTask | undefined;
            // Drain paused tasks before pulling fresh work.
            if (pausedActiveFixTasks.size > 0) {
                const firstEntry = pausedActiveFixTasks.entries().next().value as
                    | [string, QueuedFixTask]
                    | undefined;
                if (firstEntry) {
                    pausedActiveFixTasks.delete(firstEntry[0]);
                    next = firstEntry[1];
                }
            }
            if (!next && fixQueue.length > 0) {
                next = fixQueue.shift();
            }
            if (!next) {
                return;
            }

            const cts = new vscode.CancellationTokenSource();
            activeTasks.set(next.id, { task: next, cts });
            logFixQueue(
                `start task id=${next.id} index=${next.sanitizerIndex ?? 'direct'} key=${next.key}`
                + (next.batchMeta
                    ? ` batch=${next.batchMeta.batchId} (${next.batchMeta.batchIndex + 1}/${next.batchMeta.batchTotal})`
                    : ''),
            );
            notifyQueueState();

            const result = await fixSingleDiagnostic(
                next.issue,
                undefined,
                undefined,
                next.options,
                cts,
                next.options?.clearWebview,
                next.sourceDiagnostic,
            );

            const wasCancelled = cancelRequestedTaskIds.has(next.id);
            cancelRequestedTaskIds.delete(next.id);

            if (result.status === 'stopped' && pauseRequested && !wasCancelled) {
                pausedActiveFixTasks.set(next.id, next);
                activeTasks.delete(next.id);
                logFixQueue(`pause task id=${next.id} index=${next.sanitizerIndex ?? 'direct'}`);
                notifyQueueState();
                return;
            }

            const finalStatus = wasCancelled ? 'cancelled' : result.status;
            if (finalStatus === 'completed' && !result.removedDiagnostic && next.sanitizerIndex !== undefined) {
                fixedSanitizerIndices.add(next.sanitizerIndex);
            }
            // Record the completion in the recently-completed history so the
            // WebView can show what's been processed already. Statuses other
            // than the core terminal set (e.g. invalid_payload) come back from
            // the queue but never from fixSingleDiagnostic — guard the cast.
            const completedStatus: CompletedTaskStatus =
                finalStatus === 'completed' || finalStatus === 'no_change'
                || finalStatus === 'failed' || finalStatus === 'cancelled'
                || finalStatus === 'stopped'
                    ? finalStatus
                    : 'failed';
            recordCompletedTask(next, completedStatus);
            next.resolve(wasCancelled ? { status: 'cancelled' } : result);
            logFixQueue(`finish task id=${next.id} index=${next.sanitizerIndex ?? 'direct'} status=${finalStatus}`);
            activeTasks.delete(next.id);
            notifyQueueState();
            clearConversationIfCancelledAndIdle();
        }
    } finally {
        activeWorkerCount = Math.max(0, activeWorkerCount - 1);
        if (activeWorkerCount === 0) {
            notifyQueueState();
            clearConversationIfCancelledAndIdle();
        }
    }
}

/**
 * Fix the problem at `index` (0-based) in the diagnostics list from the last `msagent.parseLog` (or any parse).
 */
export function showFixDetailsPanel(): void {
    ensureFixDetailsPanel();
    webviewProvider.revealLatestSession();
}

/**
 * Register a `WebviewPanelSerializer` so VS Code can hand any "msAgent Fix Details"
 * panels left over from a previous extension activation back to our singleton.
 *
 * Without this, every reload (or every time the user closes the panel and triggers
 * another fix) creates a fresh editor tab while the orphaned ones linger — a
 * pile of empty "msAgent Fix Details" tabs builds up over time. With the
 * serializer, the *first* deserialized panel is adopted and reused; any
 * additional duplicates are disposed so the user always sees a single tab.
 */
export function registerFixDetailsSerializer(context: vscode.ExtensionContext): vscode.Disposable {
    const serializer: vscode.WebviewPanelSerializer = {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
            if (webviewProvider.hasPanel()) {
                // We already own a panel — collapse any duplicates VS Code is
                // trying to restore so the user keeps a single tab.
                panel.dispose();
                return;
            }
            webviewProvider.adopt(panel, context);
        },
    };
    return vscode.window.registerWebviewPanelSerializer(MSAGENT_FIX_VIEW_TYPE, serializer);
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
                startProcessing();
                return;
            }
            pauseRequested = true;
            notifyQueueState();
            return;
        }
        if (message.type === 'cancel_current') {
            const hasQueuedAfterCurrent = fixQueue.length > 0;
            // Cancel every running task — with N>1 concurrency multiple fixes
            // can be in flight, and the user clicking "cancel" expects all of
            // them to stop, not just one.
            if (activeTasks.size > 0) {
                for (const [id, entry] of activeTasks.entries()) {
                    cancelRequestedTaskIds.add(id);
                    entry.cts.cancel();
                }
                pauseRequested = false;
                clearConversationOnIdleAfterCancel = !hasQueuedAfterCurrent;
                notifyQueueState();
                return;
            }
            if (pausedActiveFixTasks.size > 0) {
                for (const [id, task] of pausedActiveFixTasks.entries()) {
                    pausedActiveFixTasks.delete(id);
                    task.resolve({ status: 'cancelled' });
                }
                pauseRequested = false;
                clearConversationOnIdleAfterCancel = !hasQueuedAfterCurrent;
                notifyQueueState();
                if (hasQueuedAfterCurrent) {
                    startProcessing();
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

function enqueueRepairIssue(
    issue: RepairIssue,
    options?: FixProblemOptions,
    sanitizerIndex?: number,
    sourceDiagnostic?: SanitizerDiagnostic,
    batchMeta?: FixBatchTaskMeta,
): Promise<FixProblemResult> {
    const key = getDiagnosticFixKey(issue);
    // Dedupe by file:line:errorType is meant to suppress accidental double-clicks
    // on the same diagnostic row. A batch caller (e.g. "AI fix all in group")
    // intentionally enqueues every row in a group — collapsing rows by key
    // would make the queue lie about the work it is doing, both visually (the
    // user expects N queued tasks for N selected rows) and in the result
    // summary. Sanitizer rows can legitimately share a file:line:errorType
    // even when they describe different findings (different addresses, byte
    // sizes, kernels), so for batch tasks we accept every payload unchanged
    // and rely on the queue to process them one at a time. The single-issue
    // path keeps the dedupe so a stray UI double-click still no-ops.
    if (batchMeta === undefined) {
        if (isKeyActive(key)) {
            logFixQueue(`skip enqueue key=${key} reason=already_active_key`);
            webviewProvider.revealLatestSession();
            return Promise.resolve({ status: 'already_running' });
        }
        if (isKeyPaused(key)) {
            logFixQueue(`skip enqueue key=${key} reason=already_paused_key`);
            webviewProvider.revealLatestSession();
            return Promise.resolve({ status: 'already_running' });
        }
        if (fixQueue.some((task) => task.key === key)) {
            logFixQueue(`skip enqueue key=${key} reason=already_queued_key`);
            webviewProvider.revealLatestSession();
            return Promise.resolve({ status: 'already_running' });
        }
    }

    return new Promise<FixProblemResult>((resolve) => {
        const taskId = createQueueTaskId();
        logFixQueue(
            `enqueue task id=${taskId} index=${sanitizerIndex ?? 'direct'} key=${key}`
            + (batchMeta
                ? ` batch=${batchMeta.batchId} (${batchMeta.batchIndex + 1}/${batchMeta.batchTotal})`
                : ''),
        );
        if (sanitizerIndex !== undefined) {
            fixedSanitizerIndices.delete(sanitizerIndex);
        }
        fixQueue.push({
            id: taskId,
            key,
            sanitizerIndex,
            title: getDiagnosticTitle(issue),
            issue,
            sourceDiagnostic,
            options,
            batchMeta,
            resolve,
        });
        notifyQueueState();
        startProcessing();
    });
}

export async function fixIssue(
    request: unknown,
    options?: FixProblemOptions,
): Promise<FixProblemResult> {
    ensureFixDetailsPanel();
    const normalized = normalizeFixIssueRequest(request);
    if (!normalized.ok) {
        vscode.window.showWarningMessage(`msAgent: invalid fixIssue payload: ${normalized.error}`);
        return { status: 'invalid_payload' };
    }
    return enqueueRepairIssue(
        normalized.issue,
        { clearWebview: true, ...(options ?? {}) },
    );
}

/**
 * Options for `fixIssues(...)`.
 *
 * `clearWebview` is applied only to the *first* task in the batch by default so
 * that the WebView preserves the rest of the batch's session history. Callers
 * that need a different behavior can override per-task options with `options`.
 */
export interface FixIssuesOptions {
    /** Optional caller-supplied batch identifier. Auto-generated when omitted. */
    batchId?: string;
    /** Forwarded to every task. The webview is cleared only before the first task unless `clearWebview` is false. */
    perTaskOptions?: FixProblemOptions;
}

export interface FixBatchItemResult {
    /** Index in the original `requests` array. */
    index: number;
    status: FixProblemStatus;
    /** Validation error string, present only when `status === 'invalid_payload'`. */
    error?: string;
    /** True when this entry was deduplicated against an already-queued/running fix. */
    deduplicated?: boolean;
}

export interface FixBatchResult {
    batchId: string;
    /** Number of items in the original `requests` array. */
    total: number;
    /** Number of items that passed validation and were enqueued (including dedupe skips). */
    accepted: number;
    /** Per-item results in the same order as the input. */
    results: FixBatchItemResult[];
    summary: {
        completed: number;
        no_change: number;
        failed: number;
        cancelled: number;
        stopped: number;
        already_running: number;
        invalid_payload: number;
    };
}

function createBatchId(): string {
    return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyBatchSummary(): FixBatchResult['summary'] {
    return {
        completed: 0,
        no_change: 0,
        failed: 0,
        cancelled: 0,
        stopped: 0,
        already_running: 0,
        invalid_payload: 0,
    };
}

function bumpBatchSummary(summary: FixBatchResult['summary'], status: FixProblemStatus): void {
    switch (status) {
        case 'completed':
            summary.completed += 1;
            break;
        case 'no_change':
            summary.no_change += 1;
            break;
        case 'failed':
            summary.failed += 1;
            break;
        case 'cancelled':
            summary.cancelled += 1;
            break;
        case 'stopped':
            summary.stopped += 1;
            break;
        case 'already_running':
            summary.already_running += 1;
            break;
        case 'invalid_payload':
            summary.invalid_payload += 1;
            break;
        default:
            // invalid_index / out_of_range never come back from the fixIssue path,
            // so we count them as failed for summary purposes.
            summary.failed += 1;
            break;
    }
}

/**
 * Repair a batch of caller-owned issues sequentially through the existing
 * fix queue.
 *
 * Every valid payload is enqueued as its own `QueuedFixTask` tagged with a
 * shared `batchId`. The queue processes them one at a time (reusing the pause/
 * cancel/already-running plumbing), so progress is reported per-issue through
 * `notifyQueueState`. Invalid payloads short-circuit into the result without
 * stopping the rest of the batch.
 */
export async function fixIssues(
    requests: unknown,
    options?: FixIssuesOptions,
): Promise<FixBatchResult> {
    ensureFixDetailsPanel();
    const batchId = options?.batchId ?? createBatchId();
    const summary = emptyBatchSummary();

    if (!Array.isArray(requests)) {
        vscode.window.showWarningMessage(
            'msAgent: fixIssues requires an array of issue payloads.',
        );
        return { batchId, total: 0, accepted: 0, results: [], summary };
    }

    const total = requests.length;
    if (total === 0) {
        return { batchId, total: 0, accepted: 0, results: [], summary };
    }

    logFixQueue(`batch begin id=${batchId} total=${total}`);

    type Pending = {
        index: number;
        promise: Promise<FixProblemResult>;
    };
    const pending: Pending[] = [];
    const earlyResults: Map<number, FixBatchItemResult> = new Map();

    let acceptedCount = 0;
    for (let i = 0; i < requests.length; i += 1) {
        const normalized = normalizeFixIssueRequest(requests[i]);
        if (!normalized.ok) {
            logFixQueue(`batch reject id=${batchId} index=${i} error=${normalized.error}`);
            earlyResults.set(i, {
                index: i,
                status: 'invalid_payload',
                error: normalized.error,
            });
            continue;
        }
        // Clear the webview before the first task only — matches the
        // single-issue `fixIssue` contract — but never wipe history mid-batch.
        const isFirstAccepted = acceptedCount === 0;
        const callerClearWebview = options?.perTaskOptions?.clearWebview;
        const effectiveOptions: FixProblemOptions = {
            ...(options?.perTaskOptions ?? {}),
            clearWebview: isFirstAccepted ? (callerClearWebview ?? true) : false,
        };
        const batchMeta: FixBatchTaskMeta = {
            batchId,
            batchIndex: acceptedCount,
            // batchTotal is patched after the loop once we know how many were accepted.
            batchTotal: total,
        };
        const promise = enqueueRepairIssue(
            normalized.issue,
            effectiveOptions,
            undefined,
            undefined,
            batchMeta,
        );
        pending.push({ index: i, promise });
        acceptedCount += 1;
    }

    // Patch batchTotal so it reflects the accepted count rather than the raw
    // input length. We refresh the snapshot so the webview sees the real
    // denominator immediately.
    for (const task of fixQueue) {
        if (task.batchMeta?.batchId === batchId) {
            task.batchMeta.batchTotal = acceptedCount;
        }
    }
    for (const entry of activeTasks.values()) {
        if (entry.task.batchMeta?.batchId === batchId) {
            entry.task.batchMeta.batchTotal = acceptedCount;
        }
    }
    for (const task of pausedActiveFixTasks.values()) {
        if (task.batchMeta?.batchId === batchId) {
            task.batchMeta.batchTotal = acceptedCount;
        }
    }
    notifyQueueState();

    const settled = await Promise.all(
        pending.map(async ({ index, promise }) => {
            const result = await promise;
            return { index, result };
        }),
    );

    const merged: FixBatchItemResult[] = [];
    for (let i = 0; i < requests.length; i += 1) {
        const early = earlyResults.get(i);
        if (early) {
            merged.push(early);
            bumpBatchSummary(summary, early.status);
            continue;
        }
        const settledItem = settled.find((entry) => entry.index === i);
        if (!settledItem) {
            // Should never happen — defensive default.
            merged.push({ index: i, status: 'failed' });
            bumpBatchSummary(summary, 'failed');
            continue;
        }
        const status = settledItem.result.status;
        const deduplicated = status === 'already_running';
        merged.push({
            index: i,
            status,
            ...(deduplicated ? { deduplicated: true } : {}),
        });
        bumpBatchSummary(summary, status);
    }

    logFixQueue(
        `batch end id=${batchId} total=${total} accepted=${acceptedCount}`
        + ` completed=${summary.completed} no_change=${summary.no_change}`
        + ` failed=${summary.failed} cancelled=${summary.cancelled}`
        + ` stopped=${summary.stopped} already_running=${summary.already_running}`
        + ` invalid_payload=${summary.invalid_payload}`,
    );

    return {
        batchId,
        total,
        accepted: acceptedCount,
        results: merged,
        summary,
    };
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
    if (isSanitizerIndexActive(index)) {
        logFixQueue(`skip enqueue index=${index} reason=already_active_index`);
        webviewProvider.revealLatestSession();
        return { status: 'already_running' };
    }
    if (isSanitizerIndexPaused(index)) {
        logFixQueue(`skip enqueue index=${index} reason=already_paused_index`);
        webviewProvider.revealLatestSession();
        return { status: 'already_running' };
    }
    if (fixQueue.some((task) => task.sanitizerIndex === index)) {
        logFixQueue(`skip enqueue index=${index} reason=already_queued_index`);
        webviewProvider.revealLatestSession();
        return { status: 'already_running' };
    }
    return enqueueRepairIssue(
        repairIssueFromSanitizerDiagnostic(diagnostic),
        options,
        index,
        diagnostic,
    );
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
    diagnostic: RepairIssue,
    current?: number,
    total?: number,
    options?: FixProblemOptions,
    externalCancellationTokenSource?: vscode.CancellationTokenSource,
    clearWebview: boolean = true,
    sourceDiagnostic?: SanitizerDiagnostic,
): Promise<FixProblemResult> {
    const config = getLLMConfig();
    const backend = createFixBackend(config);
    const workspaceRoot = vscode.workspace.rootPath || '.';
    const fixStartedAt = Date.now();

    const progressTitle = total && current
        ? `msAgent: Fixing ${diagnostic.errorType} (${current}/${total})`
        : `msAgent: Fixing ${diagnostic.errorType}`;
    const repairRunId = createFixRunId();

    logFix(
        `start runId=${repairRunId} backend=${backend.name} model=${config.modelFullName || config.modelID || 'default'}`
        + ` timeoutMs=${config.timeoutMs}`
        + ` errorType=${diagnostic.errorType} file=${path.basename(diagnostic.fileName)}:${diagnostic.lineNumber}`
        + ` workspaceRoot=${workspaceRoot}`,
    );

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
                // Reset the recently-completed history too so the WebView's
                // "Completed" list reflects this run, not whatever was on
                // screen before.
                resetCompletedHistory();
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
                progress.report({ message: 'Preparing the repair context...', increment: 0 });

                const postRunMessage = (message: { type: any; payload: any }): void => {
                    webviewProvider.postMessage({
                        ...message,
                        runId: repairRunId,
                    });
                };

                const resolvedPath = resolveFilePath(diagnostic.fileName, workspaceRoot);
                const originalContent = fs.existsSync(resolvedPath) 
                    ? fs.readFileSync(resolvedPath, 'utf-8') 
                    : '';

                const taskId = webviewProvider.nextMessageId();

                // Show the user prompt in the webview as a user message bubble
                const userMessageId = webviewProvider.nextMessageId();
                const userPromptSummary =
                    'Repair ' + diagnostic.errorType +
                    ' in ' + path.basename(diagnostic.fileName) + ':' + diagnostic.lineNumber +
                    (diagnostic.kernelName ? ' · kernel ' + diagnostic.kernelName : '');
                postRunMessage({
                    type: 'user_message',
                    payload: {
                        messageId: userMessageId,
                        text: userPromptSummary,
                    },
                });

                // Surface task info as a step (not a text_stream): text_stream is
                // the assistant's natural-language explanation channel and must not
                // be polluted with host-generated narration.
                postRunMessage({
                    type: 'step_update',
                    payload: {
                        step: 'Analyzing ' + diagnostic.errorType,
                        detail: 'line ' + diagnostic.lineNumber,
                    }
                });

                const activeMessageIds = new Set<string>();
                activeMessageIds.add(taskId);
                const callbacks: FixCallbacks = {
                    onMessageChunk: (chunk: StreamChunk, messageId: string) => {
                        if (cancellationTokenSource.token.isCancellationRequested) return;
                        if (chunk.type === 'text_delta' && chunk.delta) {
                            activeMessageIds.add(messageId);
                            postRunMessage({
                                type: 'text_stream',
                                payload: { messageId, delta: chunk.delta }
                            });
                        }
                    },
                    onToolCall: (name, params, toolCallId) => {
                        if (cancellationTokenSource.token.isCancellationRequested) return;
                        progress.report({
                            message: `Running ${name.replace(/_/g, ' ')}...`,
                            increment: 10,
                        });
                        postRunMessage({
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
                        postRunMessage({
                            type: 'tool_result',
                            payload: { toolCallId, result, isError }
                        });
                    },
                    onDiff: (filePath, oldText, newText, toolCallId) => {
                        if (cancellationTokenSource.token.isCancellationRequested) return;
                        postRunMessage({
                            type: 'diff',
                            payload: { path: filePath, oldText, newText, toolCallId }
                        });
                    },
                    onEvent: (type: string, payload: unknown) => {
                        if (cancellationTokenSource.token.isCancellationRequested) return;
                        switch (type) {
                            case 'session_start':
                                postRunMessage({
                                    type: 'session_start',
                                    payload: payload as { backend: string; mode?: string; model?: string },
                                });
                                break;
                            case 'session_metadata':
                                postRunMessage({
                                    type: 'session_metadata',
                                    payload: payload as { opencodeSessionId?: string },
                                });
                                break;
                            case 'session_end':
                                {
                                    const sessionEndPayload = payload as {
                                        success: boolean;
                                        outcome: 'applied' | 'no_change' | 'failed';
                                        finalMessage: string;
                                        explanationKind?: 'structured' | 'synthetic' | 'plain' | 'missing';
                                    };
                                    logFixResult(
                                        sessionEndPayload.outcome,
                                        sessionEndPayload.finalMessage,
                                        sessionEndPayload.explanationKind,
                                    );
                                }
                                postRunMessage({
                                    type: 'session_end',
                                    payload: payload as {
                                        success: boolean;
                                        outcome: 'applied' | 'no_change' | 'failed';
                                        finalMessage: string;
                                        explanationKind?: 'structured' | 'synthetic' | 'plain' | 'missing';
                                    },
                                });
                                break;
                            case 'status':
                                postRunMessage({
                                    type: 'status',
                                    payload: payload as { phase: string; message?: string },
                                });
                                break;
                            case 'backend_info':
                                postRunMessage({
                                    type: 'backend_info',
                                    payload: payload as { backend: string; mode: string; model?: string },
                                });
                                break;
                            case 'step_update':
                                postRunMessage({
                                    type: 'step_update',
                                    payload: payload as { step: string; detail?: string },
                                });
                                break;
                            default:
                                break;
                        }
                    },
                };

                        postRunMessage({
                            type: 'backend_info',
                            payload: {
                                backend: backend.name,
                                mode: 'server',
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
                        postRunMessage({
                            type: 'final_diff',
                            payload: {
                                path: resolvedPath,
                                oldContent: fixResult.originalContent,
                                newContent: fixResult.newContent,
                                message: fixResult.finalMessage,
                                explanationKind: fixResult.explanationKind,
                            }
                        });
                    }
                } finally {
                    for (const msgId of activeMessageIds) {
                        postRunMessage({
                            type: 'message_complete',
                            payload: { messageId: msgId }
                        });
                    }
                }

                return fixResult!;
            },
        );

        const fixSucceeded = (
            !cancellationTokenSource.token.isCancellationRequested
            && result.outcome === 'applied'
            && result.success
            && result.fileChanged
        );
        // Only clear the diagnostic that was actually fixed so unrelated
        // issues in the same file keep their highlights and remain actionable.
        const removedDiagnostic = fixSucceeded && sourceDiagnostic
            ? DiagnosticsManager.removeDiagnostic(sourceDiagnostic)
            : false;

        if (fixSucceeded && !sourceDiagnostic) {
            logFixQueue(`direct issue fixed key=${getDiagnosticFixKey(diagnostic)}`);
        }

        if (cancellationTokenSource.token.isCancellationRequested) {
            logFix(`exit runId=${repairRunId} status=stopped elapsed=${formatElapsed(Date.now() - fixStartedAt)}`);
            // The backend doesn't always emit a terminal `session_end` when it
            // gets cancelled mid-flight, so the WebView would otherwise be
            // stuck showing "Repairing" with the elapsed timer ticking. Post a
            // synthetic session_end so the panel transitions to a terminal
            // state and freezes its current content for the user to review.
            webviewProvider.postMessage({
                type: 'session_end',
                runId: repairRunId,
                payload: {
                    success: false,
                    outcome: 'cancelled',
                    finalMessage: 'Cancelled by user.',
                },
            } as any);
            return { status: 'stopped' };
        }
        if (result.outcome === 'no_change') {
            logFix(`exit runId=${repairRunId} status=no_change elapsed=${formatElapsed(Date.now() - fixStartedAt)}`);
            return { status: 'no_change' };
        }
        if (!result.success) {
            logFix(
                `exit runId=${repairRunId} status=failed elapsed=${formatElapsed(Date.now() - fixStartedAt)}`
                + ` toolCalls=${result.toolCallCount} fileChanged=${result.fileChanged}`,
            );
            return { status: 'failed' };
        }
        logFix(
            `exit runId=${repairRunId} status=completed elapsed=${formatElapsed(Date.now() - fixStartedAt)}`
            + ` toolCalls=${result.toolCallCount} fileChanged=${result.fileChanged}`
            + ` removedDiagnostic=${removedDiagnostic}`,
        );
        return { status: 'completed', removedDiagnostic };
    } catch (e) {
        // Session already sends session_end via onEvent callback on error.
        // Just show the VSCode error notification here.
        const errMsg = e instanceof Error ? e.message : String(e);
        logFix(
            `exit runId=${repairRunId} status=exception elapsed=${formatElapsed(Date.now() - fixStartedAt)}`
            + ` error=${errMsg.replace(/\s+/g, ' ').slice(0, 200)}`,
        );
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
    let friendly = '❌ msAgent fix failed\n\n';
    friendly += 'OpenCode server mode failed.\n\n';
    friendly += 'Current configuration:\n';
    friendly += `• CLI path: ${config.opencodeCliPath}\n`;
    friendly += `• Server port: ${config.opencodeServePort}\n`;
    friendly += '\n';
    friendly += 'Underlying error:\n';
    friendly += `${message}\n\n`;
        friendly += 'Please ensure:\n';
    friendly += '• OpenCode is installed and available in your PATH\n';
    friendly += `• OpenCode can start with \`opencode serve --port ${config.opencodeServePort}\`\n`;
    friendly += '• Review the msAgent settings if the CLI path, model, port, or timeout changed';
    return friendly;
}

function handleFixError(e: unknown, config: ReturnType<typeof getLLMConfig>) {
    const message = e instanceof Error ? e.message : String(e);
    getOutputChannel().appendLine(`[FIX] exception ${message}`);
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
    activeTasks.clear();
    activeWorkerCount = 0;
    pausedActiveFixTasks.clear();
    cancelRequestedTaskIds.clear();
    pauseRequested = false;
    clearConversationOnIdleAfterCancel = false;
    fixedSanitizerIndices.clear();
    resetCompletedHistory();
}

export function _resetFixOutputChannelForTests() {
    outputChannel = undefined;
}

export function _enqueueFixTask(
    task: (Omit<QueuedFixTask, 'id' | 'issue'> & {
        id?: string;
        issue?: RepairIssue;
        diagnostic?: SanitizerDiagnostic;
    }),
) {
    const issue = task.issue
        ?? (task.diagnostic ? repairIssueFromSanitizerDiagnostic(task.diagnostic) : undefined);
    if (!issue) {
        throw new Error('_enqueueFixTask requires issue or diagnostic');
    }
    const { diagnostic: _diagnostic, ...rest } = task;
    fixQueue.push({ ...rest, issue, id: task.id || `test_${Math.random()}` });
}

function makeSyntheticFakeIssue(key: string, sanitizerIndex?: number): RepairIssue {
    return {
        issueType: 'TEST',
        errorType: 'TEST',
        severity: Severity.ERROR,
        fileName: 'test.cpp',
        lineNumber: sanitizerIndex ?? 0,
        message: key,
        rawLines: [],
    };
}

export function _setActiveFix(index: number, title?: string) {
    const taskId = `__test_active_${index}_${Math.random().toString(36).slice(2, 8)}`;
    const fakeTask: QueuedFixTask = {
        id: taskId,
        key: `__test_key_${index}`,
        sanitizerIndex: index,
        title: title ?? `__test_${index}`,
        issue: makeSyntheticFakeIssue(`__test_key_${index}`, index),
        resolve: () => {},
    };
    activeTasks.set(taskId, {
        task: fakeTask,
        cts: { token: { isCancellationRequested: false }, cancel: () => {}, dispose: () => {} } as any,
    });
}

export function _setActiveBatchMeta(meta: FixBatchTaskMeta | undefined) {
    for (const [id, entry] of activeTasks.entries()) {
        if (id.startsWith('__test_batch_')) {
            activeTasks.delete(id);
        }
        else if (entry.task.batchMeta && id.startsWith('__test_active_')) {
            entry.task.batchMeta = undefined;
        }
    }
    if (meta === undefined) {
        return;
    }
    const taskId = `__test_batch_${meta.batchId}_${Math.random().toString(36).slice(2, 8)}`;
    const fakeTask: QueuedFixTask = {
        id: taskId,
        key: `__test_batch_key_${meta.batchIndex}`,
        title: `__test_batch_${meta.batchIndex}`,
        issue: makeSyntheticFakeIssue(`__test_batch_key_${meta.batchIndex}`),
        batchMeta: meta,
        resolve: () => {},
    };
    activeTasks.set(taskId, {
        task: fakeTask,
        cts: { token: { isCancellationRequested: false }, cancel: () => {}, dispose: () => {} } as any,
    });
}

export function _setPausedFix(task: QueuedFixTask | undefined) {
    pausedActiveFixTasks.clear();
    if (task !== undefined) {
        pausedActiveFixTasks.set(task.id, task);
    }
}

export function _setPauseRequested(v: boolean) {
    pauseRequested = v;
}

export function _addFixedIndex(index: number) {
    fixedSanitizerIndices.add(index);
}

export function _recordCompletedTaskForTests(task: QueuedFixTask, status: CompletedTaskStatus) {
    recordCompletedTask(task, status);
}
