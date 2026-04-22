export type WebviewMessageType =
    | 'text_stream'
    | 'tool_call'
    | 'tool_result'
    | 'diff'
    | 'final_diff'
    | 'message_complete'
    | 'error'
    | 'clear'
    | 'queue_state'
    | 'settings_init'
    | 'settings_update'
    | 'settings_save'
    | 'settings_test_connection'
    | 'settings_test_result'
    | 'settings_reset';

export type WebviewPayload =
    | TextStreamPayload
    | ToolCallPayload
    | ToolResultPayload
    | DiffPayload
    | FinalDiffPayload
    | ErrorPayload
    | ClearPayload
    | QueueStatePayload
    | SettingsInitPayload
    | SettingsUpdatePayload
    | SettingsSavePayload
    | SettingsTestResultPayload
    | SettingsResetPayload;

export interface WebviewMessage {
    type: WebviewMessageType;
    payload: WebviewPayload;
}

export interface TextStreamPayload {
    messageId: string;
    delta: string;
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

export interface SettingsInitPayload {
    agentMode: string;
    modelEndpoint: string;
    modelName: string;
    apiKey: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    opencodeCliPath: string;
}

export interface SettingsUpdatePayload {
    field: string;
    value: string | number;
}

export interface SettingsSavePayload {
    settings: SettingsInitPayload;
}

export interface SettingsTestResultPayload {
    success: boolean;
    message: string;
}

export interface SettingsResetPayload {}
