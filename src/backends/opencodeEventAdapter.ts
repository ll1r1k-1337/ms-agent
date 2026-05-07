export interface OpenCodeEvent {
    type?: string;
    part?: unknown;
    properties?: unknown;
    error?: unknown;
    [key: string]: unknown;
}

function resolvePart(event: unknown): unknown {
    if (!isRecordLike(event)) { return undefined; }
    // OpenCode SSE events nest part under properties: { type, properties: { part: {...} } }
    if (isRecordLike(event.properties) && event.properties.part !== undefined) {
        return event.properties.part;
    }
    // Direct part access (CLI JSON mode)
    if (event.part !== undefined) {
        return event.part;
    }
    return undefined;
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

function readStringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

export function extractSessionId(event: unknown): string | null {
    if (!isRecordLike(event)) {
        return null;
    }
    const topLevel = readStringField(event, 'sessionID', 'sessionId');
    if (topLevel) {
        return topLevel;
    }
    if (isRecordLike(event.properties)) {
        const nested = readStringField(event.properties, 'sessionID', 'sessionId');
        if (nested) {
            return nested;
        }
        if (isRecordLike(event.properties.info)) {
            const fromInfo = readStringField(event.properties.info, 'sessionID', 'sessionId');
            if (fromInfo) {
                return fromInfo;
            }
        }
    }
    const part = resolvePart(event);
    if (isRecordLike(part)) {
        return readStringField(part, 'sessionID', 'sessionId') ?? null;
    }
    return null;
}

export function extractMessageRole(event: unknown): string | null {
    if (!isRecordLike(event)) {
        return null;
    }
    if (typeof event.role === 'string') {
        return event.role;
    }
    if (isRecordLike(event.properties) && isRecordLike(event.properties.info)) {
        return readStringField(event.properties.info, 'role') ?? null;
    }
    return null;
}

export function extractMessageId(event: unknown): string | null {
    if (!isRecordLike(event)) {
        return null;
    }
    if (typeof event.messageID === 'string') {
        return event.messageID;
    }
    if (typeof event.messageId === 'string') {
        return event.messageId;
    }
    if (isRecordLike(event.properties) && isRecordLike(event.properties.info)) {
        return readStringField(event.properties.info, 'id', 'messageID', 'messageId') ?? null;
    }
    return null;
}

export function extractPartMessageId(event: unknown): string | null {
    const part = resolvePart(event);
    if (!isRecordLike(part)) {
        return null;
    }
    return readStringField(part, 'messageID', 'messageId') ?? null;
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
        const part = resolvePart(event);
        if (isToolUsePart(part)) {
            const name = part.tool || part.toolName || part.name;
            if (name) {
                if (isRecordLike(part.state)) {
                    const stateType = readStringField(part.state, 'type', 'status');
                    if (stateType && stateType !== 'pending') {
                        return null;
                    }
                }
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

    const part = resolvePart(event);
    if (isToolUsePart(part)) {
        const name = part.tool || part.toolName || part.name;
        if (name) {
            if (isRecordLike(part.state)) {
                const stateType = readStringField(part.state, 'type', 'status');
                if (stateType && stateType !== 'pending') {
                    return null;
                }
            }
            const params = isRecordLike(part.state)
                ? safeParseParams(part.state.input)
                : safeParseParams(part.input || part.args || part.arguments);
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
    if (isToolCallPart(part)) {
        const tc = part.tool_call || part.toolCall || part;
        const name = resolveToolName(tc);
        if (name) {
            return { name, params: resolveToolParams(tc), toolCallId: resolveToolCallId(tc) };
        }
    }

    // Handle OpenAI-style tool_calls array in choices
    if (isRecordLike(event.choices) && Array.isArray(event.choices) && event.choices.length > 0) {
        const choice = event.choices[0];
        if (isRecordLike(choice)) {
            const message = choice.message || choice.delta;
            if (isRecordLike(message) && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                const tc = message.tool_calls[0];
                if (isRecordLike(tc)) {
                    const fn = tc.function;
                    if (isRecordLike(fn) && typeof fn.name === 'string') {
                        return {
                            name: fn.name,
                            params: safeParseParams(fn.arguments),
                            toolCallId: (typeof tc.id === 'string' ? tc.id : undefined) || 'unknown',
                        };
                    }
                }
            }
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
        const part = resolvePart(event);
        if (isToolUsePart(part) && isRecordLike(part.state)) {
            const stateType = readStringField(part.state, 'type', 'status');
            if (!stateType || (stateType !== 'completed' && stateType !== 'error' && stateType !== 'failed')) {
                return null;
            }
            const isError = stateType === 'error' || stateType === 'failed' || !!part.state.error;
            const result = part.state.result ?? part.state.output ?? part.state.data ?? `Status: ${stateType}`;
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

    const part = resolvePart(event);
    if (isToolUsePart(part) && isRecordLike(part.state)) {
        const stateType = readStringField(part.state, 'type', 'status');
        if (!stateType || (stateType !== 'completed' && stateType !== 'error' && stateType !== 'failed')) {
            return null;
        }
        const toolCallId =
            (typeof part.callID === 'string' ? part.callID : undefined) ||
            (typeof part.callId === 'string' ? part.callId : undefined) ||
            (typeof part.id === 'string' ? part.id : undefined) ||
            'unknown';
        const result = part.state.result ?? part.state.output ?? part.state.data ?? `Status: ${stateType}`;
        return {
            toolCallId,
            result: typeof result === 'string' ? result : JSON.stringify(result),
            isError: stateType === 'error' || stateType === 'failed' || !!part.state.error,
        };
    }
    if (isToolResultPart(part)) {
        const trRaw = part.tool_result || part.toolResult || part;
        const tr = isRecordLike(trRaw) ? trRaw : {};
        const toolCallId =
            (typeof tr.toolCallId === 'string' ? tr.toolCallId : undefined) ||
            (typeof tr.id === 'string' ? tr.id : undefined) ||
            (typeof tr.tool_call_id === 'string' ? tr.tool_call_id : undefined) ||
            (typeof part.toolCallId === 'string' ? part.toolCallId : undefined) ||
            (typeof part.id === 'string' ? part.id : undefined) ||
            'unknown';
        return {
            toolCallId,
            result: resolveResultValue(tr),
            isError: !!(tr.isError || tr.error),
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
    // 1. Check properties.part (OpenCode SSE bus event format)
    const part = resolvePart(event);
    if (isRecordLike(part)) {
        if (typeof part.text === 'string') {
            return part.text;
        }
        if (typeof part.content === 'string') {
            return part.content;
        }
        if (typeof part.delta === 'string') {
            return part.delta;
        }
        if (typeof part.output === 'string') {
            return part.output;
        }
        if (typeof part.message === 'string') {
            return part.message;
        }
        if (isRecordLike(part.delta) && typeof part.delta.content === 'string') {
            return part.delta.content;
        }
    }

    // 2. Check properties directly (alternative nesting)
    if (isRecordLike(event.properties)) {
        const props = event.properties;
        if (typeof props.text === 'string') { return props.text; }
        if (typeof props.content === 'string') { return props.content; }
        if (typeof props.delta === 'string') { return props.delta; }
        if (typeof props.message === 'string') { return props.message; }
    }

    // 3. Check parts array (OpenCode message response format)
    if (isRecordLike(event.parts) && Array.isArray(event.parts) && event.parts.length > 0) {
        const firstPart = event.parts[0];
        if (isRecordLike(firstPart)) {
            if (typeof firstPart.text === 'string') { return firstPart.text; }
            if (typeof firstPart.content === 'string') { return firstPart.content; }
            if (typeof firstPart.delta === 'string') { return firstPart.delta; }
        }
    }

    // 4. Check top-level fields
    if (typeof event.text === 'string') {
        return event.text;
    }
    if (typeof event.content === 'string') {
        return event.content;
    }
    if (typeof event.delta === 'string') {
        return event.delta;
    }
    if (typeof event.output === 'string') {
        return event.output;
    }
    if (typeof event.message === 'string') {
        return event.message;
    }
    if (typeof event.response === 'string') {
        return event.response;
    }

    // 5. Check OpenAI-style choices
    if (isRecordLike(event.choices) && Array.isArray(event.choices) && event.choices.length > 0) {
        const choice = event.choices[0];
        if (isRecordLike(choice)) {
            if (isRecordLike(choice.delta) && typeof choice.delta.content === 'string') {
                return choice.delta.content;
            }
            if (isRecordLike(choice.message) && typeof choice.message.content === 'string') {
                return choice.message.content;
            }
        }
    }
    return null;
}

export function extractErrorMessage(event: OpenCodeEvent): string | null {
    const candidates: unknown[] = [event.error];
    if (isRecordLike(event.properties)) {
        candidates.push(event.properties.error);
        if (isRecordLike(event.properties.info)) {
            candidates.push(event.properties.info.error);
        }
    }

    for (const candidate of candidates) {
        if (candidate === undefined) {
            continue;
        }
        if (typeof candidate === 'string') {
            return candidate;
        }
        if (isRecordLike(candidate)) {
            const data = candidate.data;
            if (isRecordLike(data) && typeof data.message === 'string') {
                return data.message;
            }
            if (typeof candidate.message === 'string') {
                return candidate.message;
            }
        }
        try {
            return JSON.stringify(candidate);
        } catch {
            return String(candidate);
        }
    }

    return null;
}

export function extractAssistantFinishReason(event: OpenCodeEvent): string | null {
    if (event.type === 'message.updated' && isRecordLike(event.properties)) {
        const info = event.properties.info;
        if (isRecordLike(info) && info.role === 'assistant') {
            const finish = info.finish;
            if (typeof finish === 'string' && finish.length > 0) {
                return finish;
            }
        }
    }

    if (isRecordLike(event.choices) && Array.isArray(event.choices) && event.choices.length > 0) {
        const choice = event.choices[0];
        if (isRecordLike(choice)) {
            const finish = choice.finish_reason ?? choice.finishReason;
            if (typeof finish === 'string' && finish.length > 0) {
                return finish;
            }
        }
    }

    return null;
}

/**
 * Hard, protocol-level terminal events. These are the ONLY signals that may
 * advance the session to applying_patch. Soft-close signals such as
 * `session.idle` / `server.disconnect` are intentionally NOT in this list —
 * they only mean "the wire went quiet", not "the model is done".
 */
const HARD_TERMINAL_TYPES: ReadonlySet<string> = new Set([
    'step_end',
    'message_end',
    'done',
    'complete',
    'finish',
    'stop',
    'session.end',
    'session.done',
]);

const SOFT_CLOSE_TYPES: ReadonlySet<string> = new Set([
    'session.idle',
    'session.error',
    'server.disconnect',
    'end',
]);

export function isCompletionEvent(event: OpenCodeEvent): boolean {
    const t = event.type ?? '';
    if (HARD_TERMINAL_TYPES.has(t)) {
        return true;
    }
    if (event.type === 'message.updated' && isRecordLike(event.properties)) {
        const info = (event.properties as Record<string, unknown>).info;
        if (isRecordLike(info)) {
            if (info.role !== 'assistant') {
                return false;
            }
            const time = (info as Record<string, unknown>).time;
            if (isRecordLike(time)) {
                const completed = (time as Record<string, unknown>).completed;
                if (typeof completed === 'number' && completed > 0) {
                    return true;
                }
            }
        }
    }
    if (isRecordLike(event.choices) && Array.isArray(event.choices) && event.choices.length > 0) {
        const choice = event.choices[0];
        if (isRecordLike(choice) && choice.finish_reason) {
            return true;
        }
    }
    return false;
}

export function isToolCallContinuationBoundary(event: OpenCodeEvent): boolean {
    return isCompletionEvent(event) && extractAssistantFinishReason(event) === 'tool-calls';
}

/**
 * Soft-close signals: the wire went quiet but the model has NOT explicitly
 * said it's done. The session layer maps these to TRANSPORT_CLOSED, which
 * (per the state machine) becomes an error if no hard terminal was seen.
 */
export function isSoftCloseEvent(event: OpenCodeEvent): boolean {
    return SOFT_CLOSE_TYPES.has(event.type ?? '');
}
