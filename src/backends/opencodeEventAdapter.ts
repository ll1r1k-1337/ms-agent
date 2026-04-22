export interface OpenCodeEvent {
    type?: string;
    part?: unknown;
    error?: unknown;
    [key: string]: unknown;
}

export interface ToolCallInfo {
    name: string;
    params: Record<string, unknown>;
    toolCallId?: string;
}

export interface ToolResultInfo {
    toolCallId: string;
    result: string;
    isError: boolean;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

export function safeParseParams(maybeJson: unknown): Record<string, unknown> {
    if (typeof maybeJson !== 'string') {
        return isRecordLike(maybeJson) ? maybeJson : {};
    }
    try {
        const parsed = JSON.parse(maybeJson);
        return isRecordLike(parsed) ? parsed : { raw: maybeJson };
    } catch {
        return { raw: maybeJson };
    }
}

export function resolveToolName(tc: unknown): string | undefined {
    if (!isRecordLike(tc)) {
        return undefined;
    }
    if (typeof tc.name === 'string') { return tc.name; }
    if (typeof tc.toolName === 'string') { return tc.toolName; }
    if (isRecordLike(tc.function) && typeof tc.function.name === 'string') {
        return tc.function.name;
    }
    return undefined;
}

export function resolveToolParams(tc: unknown): Record<string, unknown> {
    if (!isRecordLike(tc)) {
        return {};
    }
    const args = tc.arguments || tc.args || tc.input || tc.parameters;
    if (args !== undefined) {
        return safeParseParams(args);
    }
    if (isRecordLike(tc.function)) {
        return safeParseParams(tc.function.arguments);
    }
    return {};
}

export function resolveToolCallId(tc: unknown): string | undefined {
    if (!isRecordLike(tc)) {
        return undefined;
    }
    if (typeof tc.id === 'string') { return tc.id; }
    if (typeof tc.toolCallId === 'string') { return tc.toolCallId; }
    if (typeof tc.tool_call_id === 'string') { return tc.tool_call_id; }
    return undefined;
}

export function resolveResultValue(tr: unknown): string {
    if (!isRecordLike(tr)) {
        return '';
    }
    const raw = tr.result ?? tr.output ?? tr.content ?? tr.data;
    if (typeof raw === 'string') { return raw; }
    if (raw === undefined) { return ''; }
    try {
        return JSON.stringify(raw);
    } catch {
        return String(raw);
    }
}

export function isToolCallEvent(event: unknown): event is Record<string, unknown> {
    if (!isRecordLike(event)) { return false; }
    const t = event.type;
    return t === 'tool_call' || t === 'tool-call';
}

export function isToolResultEvent(event: unknown): event is Record<string, unknown> {
    if (!isRecordLike(event)) { return false; }
    const t = event.type;
    return t === 'tool_result' || t === 'tool-result';
}

export function isToolUseEvent(event: unknown): event is Record<string, unknown> {
    if (!isRecordLike(event)) { return false; }
    return event.type === 'tool_use';
}

export function isToolCallPart(part: unknown): part is Record<string, unknown> {
    if (!isRecordLike(part)) { return false; }
    const t = part.type;
    return t === 'tool_call' || t === 'tool-call';
}

export function isToolResultPart(part: unknown): part is Record<string, unknown> {
    if (!isRecordLike(part)) { return false; }
    const t = part.type;
    return t === 'tool_result' || t === 'tool-result';
}

export function isToolUsePart(part: unknown): part is Record<string, unknown> {
    if (!isRecordLike(part)) { return false; }
    return part.type === 'tool';
}

export function extractToolCall(event: unknown): ToolCallInfo | null {
    if (!isRecordLike(event)) { return null; }

    if (isToolCallEvent(event)) {
        const tc = event.tool_call || event.toolCall || event.data;
        const name = resolveToolName(tc);
        if (name) {
            return { name, params: resolveToolParams(tc), toolCallId: resolveToolCallId(tc) };
        }
    }

    if (isToolUseEvent(event)) {
        const part = event.part;
        if (isToolUsePart(part)) {
            const name = part.tool || part.toolName || part.name;
            if (name) {
                let params: Record<string, unknown>;
                if (isRecordLike(part.state)) {
                    params = safeParseParams(part.state.input);
                } else {
                    params = safeParseParams(part.input || part.args || part.arguments);
                }
                const toolCallId =
                    (typeof part.callID === 'string' ? part.callID : undefined) ||
                    (typeof part.callId === 'string' ? part.callId : undefined) ||
                    (typeof part.id === 'string' ? part.id : undefined) ||
                    'unknown';
                return {
                    name: String(name),
                    params,
                    toolCallId,
                };
            }
        }
    }

    const part = event.part;
    if (isToolCallPart(part)) {
        const name = resolveToolName(part);
        if (name) {
            return { name, params: resolveToolParams(part), toolCallId: resolveToolCallId(part) };
        }
    }

    if (event.toolName || event.name) {
        const name = event.toolName || event.name;
        return {
            name: String(name),
            params: safeParseParams(event.args || event.arguments || event.input),
            toolCallId:
                (typeof event.toolCallId === 'string' ? event.toolCallId : undefined) ||
                (typeof event.id === 'string' ? event.id : undefined) ||
                (typeof event.tool_call_id === 'string' ? event.tool_call_id : undefined),
        };
    }

    return null;
}

export function extractToolResult(event: unknown): ToolResultInfo | null {
    if (!isRecordLike(event)) { return null; }

    if (isToolResultEvent(event)) {
        const tr = event.tool_result || event.toolResult || event.data;
        if (isRecordLike(tr)) {
            const toolCallId =
                (typeof tr.toolCallId === 'string' ? tr.toolCallId : undefined) ||
                (typeof tr.id === 'string' ? tr.id : undefined) ||
                (typeof tr.tool_call_id === 'string' ? tr.tool_call_id : undefined) ||
                'unknown';
            return {
                toolCallId,
                result: resolveResultValue(tr),
                isError: !!(tr.isError || tr.error),
            };
        }
    }

    if (isToolUseEvent(event)) {
        const part = event.part;
        if (isToolUsePart(part) && isRecordLike(part.state)) {
            const status = part.state.status;
            const isError = status === 'error' || status === 'failed';
            const result = part.state.result ?? part.state.output ?? part.state.data ?? `Status: ${status}`;
            const toolCallId =
                (typeof part.callID === 'string' ? part.callID : undefined) ||
                (typeof part.callId === 'string' ? part.callId : undefined) ||
                (typeof part.id === 'string' ? part.id : undefined) ||
                'unknown';
            return {
                toolCallId,
                result: typeof result === 'string' ? result : JSON.stringify(result),
                isError,
            };
        }
    }

    const part = event.part;
    if (isToolResultPart(part)) {
        const toolCallId =
            (typeof part.toolCallId === 'string' ? part.toolCallId : undefined) ||
            (typeof part.id === 'string' ? part.id : undefined) ||
            (typeof part.tool_call_id === 'string' ? part.tool_call_id : undefined) ||
            'unknown';
        return {
            toolCallId,
            result: resolveResultValue(part),
            isError: !!(part.isError || part.error),
        };
    }

    if (event.result !== undefined && (event.toolCallId || event.id)) {
        return {
            toolCallId: String(event.toolCallId || event.id || 'unknown'),
            result: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
            isError: !!(event.isError || event.error),
        };
    }

    return null;
}

export function parseEventLine(line: string): OpenCodeEvent | null {
    try {
        const parsed = JSON.parse(line);
        if (isRecordLike(parsed)) {
            return parsed as OpenCodeEvent;
        }
        return null;
    } catch {
        return null;
    }
}

export function extractTextDelta(event: OpenCodeEvent): string | null {
    if (isRecordLike(event.part) && typeof event.part.text === 'string') {
        return event.part.text;
    }
    if (typeof event.text === 'string') {
        return event.text;
    }
    return null;
}

export function extractErrorMessage(event: OpenCodeEvent): string | null {
    if (event.error === undefined) {
        return null;
    }
    if (typeof event.error === 'string') {
        return event.error;
    }
    if (isRecordLike(event.error)) {
        const data = event.error.data;
        if (isRecordLike(data) && typeof data.message === 'string') {
            return data.message;
        }
        if (typeof event.error.message === 'string') {
            return event.error.message;
        }
    }
    try {
        return JSON.stringify(event.error);
    } catch {
        return String(event.error);
    }
}

export function isCompletionEvent(event: OpenCodeEvent): boolean {
    const completionTypes = ['step_end', 'message_end', 'done', 'complete', 'finish'];
    return completionTypes.includes(event.type ?? '');
}
