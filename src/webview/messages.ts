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
    // NEW for PR-C:
    | 'session_start'
    | 'session_metadata'
    | 'session_end'
    | 'status'
    | 'backend_info'
    | 'step_update';

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
    // NEW for PR-C:
    | SessionStartPayload
    | SessionMetadataPayload
    | SessionEndPayload
    | StatusPayload
    | BackendInfoPayload
    | StepUpdatePayload;

export interface WebviewMessage {
    type: WebviewMessageType;
    payload: WebviewPayload;
    runId?: string;
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

export interface QueueStateItem {
    id: string;
    title: string;
}

export interface QueueStatePayload {
    /** User paused the fix pipeline (`pauseRequested` in fixService). */
    paused: boolean;
    /** There is active, paused, or queued work that can still be controlled. */
    hasPendingTasks: boolean;
    items: QueueStateItem[];
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
