export type WebviewMessageType =
    | 'text_stream'
    | 'user_message'
    | 'tool_call'
    | 'tool_result'
    | 'diff'
    | 'final_diff'
    | 'message_complete'
    | 'error'
    | 'clear'
    | 'queue_state'
    | 'queue_delta'
    // NEW for PR-C:
    | 'session_start'
    | 'session_metadata'
    | 'session_end'
    | 'status'
    | 'backend_info'
    | 'step_update'
    // Per-task result detail for the Tasks card's expandable Completed list:
    | 'task_detail';

export type WebviewPayload =
    | TextStreamPayload
    | UserMessagePayload
    | ToolCallPayload
    | ToolResultPayload
    | DiffPayload
    | FinalDiffPayload
    | MessageCompletePayload
    | ErrorPayload
    | ClearPayload
    | QueueStatePayload
    | QueueDeltaPayload
    // NEW for PR-C:
    | SessionStartPayload
    | SessionMetadataPayload
    | SessionEndPayload
    | StatusPayload
    | BackendInfoPayload
    | StepUpdatePayload
    | TaskDetailPayload;

export interface WebviewMessage {
    type: WebviewMessageType;
    payload: WebviewPayload;
    runId?: string;
    /** Queue task id this message belongs to. Stamped by `fixSingleDiagnostic`
     *  so the webview can route run-scoped messages to per-task runtime state.
     *  A single fix is a batch of one — every fix carries a `taskId`. */
    taskId?: string;
}

export interface TextStreamPayload {
    messageId: string;
    delta: string;
}

export interface UserMessagePayload {
    messageId: string;
    text: string;
}

export interface ToolCallPayload {
    messageId: string;
    toolCallId: string;
    name: string;
    params: Record<string, unknown>;
}

export interface ToolResultPayload {
    toolCallId: string;
    result: string;
    isError: boolean;
}

export interface DiffPayload {
    path: string;
    oldText: string;
    newText: string;
    toolCallId: string;
}

export interface FinalDiffPayload {
    path: string;
    oldContent: string;
    newContent: string;
    message: string;
    explanationKind?: 'structured' | 'synthetic' | 'plain' | 'missing';
}

export interface MessageCompletePayload {
    messageId: string;
}

export interface ErrorPayload {
    message: string;
}

export interface ClearPayload {}

// NOTE: QueueStateItem is the **webview-side** view of a queue snapshot item.
// The ms-agent host has its own `AiFixQueueSnapshotItem` in
// `src/vscode/fixService.ts`; the two are joined only by JSON serialization
// over `webview.postMessage`. Adding a required field here therefore does NOT
// break fixService at compile time — but the snapshot builder there must
// supply the same field at runtime (see task T3 of the scaling plan).
export type QueueGroup =
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface QueueStateItem {
    id: string;
    /**
     * Which group the item currently belongs to. Set by the server-side
     * snapshot builder; lets the webview reducer reconcile additions/moves
     * across groups without a separate "move" message.
     */
    group: QueueGroup;
    title: string;
    /** Present only for tasks enqueued by `fixIssues` (batch grouping). */
    batchId?: string;
    batchIndex?: number;
    batchTotal?: number;
    /** opencode session id for this task, once the backend reports it. */
    opencodeSessionId?: string;
    /**
     * Narrower than `group`: only set when `group` is `'completed'`,
     * `'failed'`, or `'cancelled'`. Carries the worker's terminal verdict
     * (e.g. `'no_change'`, `'stopped'`) which the group alone cannot express.
     */
    status?: 'completed' | 'no_change' | 'failed' | 'cancelled' | 'stopped';
    /** Unix-ms completion time — present only on `recentlyCompleted` entries. */
    completedAt?: number;
}

export interface QueueStatePayload {
    /** User paused the fix pipeline (`pauseRequested` in fixService). */
    paused: boolean;
    /** There is active, paused, or queued work that can still be controlled. */
    hasPendingTasks: boolean;
    /** Not-yet-started queued tasks. */
    items: QueueStateItem[];
    /** Tasks currently being processed by a worker. */
    runningTasks?: QueueStateItem[];
    /** Recently finished tasks, newest-first. */
    recentlyCompleted?: QueueStateItem[];
    /**
     * Aggregate counts. Optional on full-sync payloads for back-compat with
     * older snapshot producers; will become required once every producer
     * (see fixService.getAiFixQueueSnapshot) supplies it. Until then,
     * `paused` and `hasPendingTasks` above are the authoritative source.
     */
    summary?: QueueSummary;
}

export interface QueueSummary {
    paused: boolean;
    hasPendingTasks: boolean;
    /** Tasks currently running (size of activeTasks). */
    runningCount: number;
    /** Tasks waiting in the queue (size of fixQueue + pausedActiveFixTasks). */
    queuedCount: number;
    /**
     * Tasks whose terminal outcome was 'completed' or 'no_change' within the
     * current `recentlyCompleted` window (not a lifetime total). Capped by
     * MAX_RECENTLY_COMPLETED on the producer side.
     */
    completedCount: number;
}

export interface QueueDeltaPayload {
    added?: QueueStateItem[];
    removed?: string[];
    updated?: Array<Partial<QueueStateItem> & { id: string }>;
    /**
     * Always present on a delta. A delta carries no group-level item lists,
     * so the reducer relies on `summary` to update counters and the pause
     * indicator without an O(N) walk.
     */
    summary: QueueSummary;
}

// NEW for PR-C:
export interface SessionStartPayload {
    backend: string;
    mode?: string;
    model?: string;
}

export interface SessionMetadataPayload {
    opencodeSessionId?: string;
}

export interface SessionEndPayload {
    success: boolean;
    outcome: 'applied' | 'no_change' | 'failed';
    finalMessage: string;
    explanationKind?: 'structured' | 'synthetic' | 'plain' | 'missing';
}

export interface StatusPayload {
    phase: string;
    message?: string;
}

export interface BackendInfoPayload {
    backend: string;
    mode: string;
    model?: string;
}

export interface StepUpdatePayload {
    step: string;
    detail?: string;
}

/** A single file's before/after content captured during a finished fix task. */
export interface TaskDetailDiff {
    path: string;
    oldText: string;
    newText: string;
}

/**
 * Result detail for one finished fix task, keyed by the queue task id so the
 * Tasks card can show "what was applied" / "why it crashed" when the user
 * expands a Completed entry. Posted once per task (unlike `queue_state`, which
 * re-broadcasts the whole queue), so it can safely carry file contents.
 */
export interface TaskDetailPayload {
    /** Queue task id — matches `QueueStateItem.id` in `recentlyCompleted`. */
    taskId: string;
    /** Terminal status the worker stamped on the task. */
    status: 'completed' | 'no_change' | 'failed' | 'cancelled' | 'stopped';
    /** Assistant explanation (for applied) or failure reason (for failed). */
    finalMessage: string;
    explanationKind?: 'structured' | 'synthetic' | 'plain' | 'missing';
    /** File diffs captured while this task ran. Empty when nothing changed. */
    diffs: TaskDetailDiff[];
}
