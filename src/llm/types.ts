export interface StreamChunk {
    type: 'text_delta' | 'tool_use_start' | 'tool_use_delta' | 'done' | 'error';
    delta?: string;
    toolCall?: {
        id: string;
        name?: string;
        input?: Record<string, unknown>;
        inputDelta?: string;
    };
    error?: string;
}
