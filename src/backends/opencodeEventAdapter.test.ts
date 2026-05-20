import { expect } from 'chai';
import {
    OpenCodeEvent,
    safeParseParams,
    resolveToolName,
    resolveToolParams,
    resolveToolCallId,
    resolveResultValue,
    isToolCallEvent,
    isToolResultEvent,
    isToolUseEvent,
    isToolCallPart,
    isToolResultPart,
    isToolUsePart,
    extractToolCall,
    extractToolResult,
    extractToolPartParamsUpdate,
    parseEventLine,
    extractTextDelta,
    extractErrorMessage,
    extractRetryStatus,
    extractAssistantFinishReason,
    isCompletionEvent,
    isToolCallContinuationBoundary,
    extractSessionId,
    extractMessageRole,
    extractMessageId,
    extractPartMessageId,
} from './opencodeEventAdapter';

describe('opencodeEventAdapter', () => {
    describe('parseEventLine', () => {
        it('should return parsed JSON for valid line', () => {
            const line = '{"type":"text","text":"hello"}';
            const result = parseEventLine(line);
            expect(result).to.deep.equal({ type: 'text', text: 'hello' });
        });

        it('should return null for invalid JSON', () => {
            const result = parseEventLine('not json');
            expect(result).to.be.null;
        });

        it('should return null for non-object JSON', () => {
            expect(parseEventLine('42')).to.be.null;
            expect(parseEventLine('null')).to.be.null;
            expect(parseEventLine('"string"')).to.be.null;
        });
    });

    describe('extractToolCall', () => {
        it('should extract tool_call event format', () => {
            const event: OpenCodeEvent = {
                type: 'tool_call',
                tool_call: {
                    name: 'read_file',
                    arguments: '{"path":"test.cpp"}',
                    id: 'call_123',
                },
            };
            const result = extractToolCall(event);
            expect(result).to.deep.equal({
                name: 'read_file',
                params: { path: 'test.cpp' },
                toolCallId: 'call_123',
            });
        });

        it('should extract tool_use event format', () => {
            const event: OpenCodeEvent = {
                type: 'tool_use',
                part: {
                    type: 'tool',
                    tool: 'edit_file',
                    state: {
                        input: '{"oldText":"a","newText":"b"}',
                    },
                    callID: 'oc_123',
                },
            };
            const result = extractToolCall(event);
            expect(result).to.deep.equal({
                name: 'edit_file',
                params: { oldText: 'a', newText: 'b' },
                toolCallId: 'oc_123',
            });
        });

        it('should extract tool_call from nested part.tool_call (OpenCode server format)', () => {
            const event: OpenCodeEvent = {
                type: 'tool_call',
                part: {
                    type: 'tool_call',
                    tool_call: {
                        name: 'read_file',
                        arguments: '{"path":"test.cpp"}',
                        id: 'call_123',
                    },
                },
            };
            const result = extractToolCall(event);
            expect(result).to.deep.equal({
                name: 'read_file',
                params: { path: 'test.cpp' },
                toolCallId: 'call_123',
            });
        });

        it('should extract tool_call from SSE properties.part format', () => {
            const event: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'tool_call',
                        tool_call: {
                            name: 'read_file',
                            arguments: '{"path":"test.cpp"}',
                            id: 'sse_call_123',
                        },
                    },
                },
            };
            const result = extractToolCall(event);
            expect(result).to.deep.equal({
                name: 'read_file',
                params: { path: 'test.cpp' },
                toolCallId: 'sse_call_123',
            });
        });

        it('should extract pending OpenCode ToolPart calls from SSE properties.part format', () => {
            const event: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'tool',
                        tool: 'read_file',
                        callID: 'tc_read_1',
                        state: {
                            type: 'pending',
                            input: '{"path":"test.cpp"}',
                        },
                    },
                },
            };
            const result = extractToolCall(event);
            expect(result).to.deep.equal({
                name: 'read_file',
                params: { path: 'test.cpp' },
                toolCallId: 'tc_read_1',
            });
        });

        it('should return null for non-tool event', () => {
            const event: OpenCodeEvent = { type: 'text', text: 'hello' };
            expect(extractToolCall(event)).to.be.null;
        });
    });

    describe('extractToolPartParamsUpdate', () => {
        it('returns the parsed input for a pending tool part with populated input', () => {
            const event: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'tool',
                        tool: 'grep',
                        callID: 'tc_grep_1',
                        state: { type: 'pending', input: '{"pattern":"foo"}' },
                    },
                },
            };
            expect(extractToolPartParamsUpdate(event)).to.deep.equal({
                toolCallId: 'tc_grep_1',
                params: { pattern: 'foo' },
            });
        });

        it('returns the parsed input for a running tool part — the typical late-arrival shape', () => {
            const event: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'tool',
                        tool: 'grep',
                        callID: 'tc_grep_2',
                        state: { type: 'running', input: '{"pattern":"bar","path":"src"}' },
                    },
                },
            };
            expect(extractToolPartParamsUpdate(event)).to.deep.equal({
                toolCallId: 'tc_grep_2',
                params: { pattern: 'bar', path: 'src' },
            });
        });

        it('returns the parsed input for a completed tool part', () => {
            const event: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'tool',
                        tool: 'edit',
                        callID: 'tc_edit_1',
                        state: { type: 'completed', input: '{"path":"a.cpp"}' },
                    },
                },
            };
            expect(extractToolPartParamsUpdate(event)).to.deep.equal({
                toolCallId: 'tc_edit_1',
                params: { path: 'a.cpp' },
            });
        });

        it('returns empty params (not null) when input is missing or empty', () => {
            const event: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'tool',
                        tool: 'grep',
                        callID: 'tc_grep_3',
                        state: { type: 'pending' },
                    },
                },
            };
            const result = extractToolPartParamsUpdate(event);
            expect(result).to.not.be.null;
            expect(result?.toolCallId).to.equal('tc_grep_3');
            expect(result?.params).to.deep.equal({});
        });

        it('returns null when the event has no callID', () => {
            const event: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'tool',
                        tool: 'grep',
                        state: { type: 'running', input: '{"pattern":"foo"}' },
                    },
                },
            };
            expect(extractToolPartParamsUpdate(event)).to.be.null;
        });

        it('returns null for non-tool parts', () => {
            const event: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: { part: { type: 'text', text: 'hello' } },
            };
            expect(extractToolPartParamsUpdate(event)).to.be.null;
        });
    });

    describe('extractToolResult', () => {
        it('should extract tool_result event format', () => {
            const event: OpenCodeEvent = {
                type: 'tool_result',
                tool_result: {
                    toolCallId: 'call_123',
                    result: 'file content',
                    isError: false,
                },
            };
            const result = extractToolResult(event);
            expect(result).to.deep.equal({
                toolCallId: 'call_123',
                result: 'file content',
                isError: false,
            });
        });

        it('should extract tool_use result format with error status', () => {
            const event: OpenCodeEvent = {
                type: 'tool_use',
                part: {
                    type: 'tool',
                    callId: 'oc_456',
                    state: {
                        status: 'error',
                        result: 'Something went wrong',
                    },
                },
            };
            const result = extractToolResult(event);
            expect(result).to.deep.equal({
                toolCallId: 'oc_456',
                result: 'Something went wrong',
                isError: true,
            });
        });

        it('should handle tool_result with error flag', () => {
            const event: OpenCodeEvent = {
                type: 'tool_result',
                tool_result: {
                    id: 'call_789',
                    output: 'error message',
                    error: true,
                },
            };
            const result = extractToolResult(event);
            expect(result).to.deep.equal({
                toolCallId: 'call_789',
                result: 'error message',
                isError: true,
            });
        });

        it('should extract tool_result from nested part.tool_result (OpenCode server format)', () => {
            const event: OpenCodeEvent = {
                type: 'tool_result',
                part: {
                    type: 'tool_result',
                    tool_result: {
                        toolCallId: 'call_abc',
                        result: 'success output',
                        isError: false,
                    },
                },
            };
            const result = extractToolResult(event);
            expect(result).to.deep.equal({
                toolCallId: 'call_abc',
                result: 'success output',
                isError: false,
            });
        });

        it('should extract tool_result from SSE properties.part format', () => {
            const event: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'tool_result',
                        tool_result: {
                            toolCallId: 'sse_call_456',
                            result: 'sse result',
                            isError: true,
                        },
                    },
                },
            };
            const result = extractToolResult(event);
            expect(result).to.deep.equal({
                toolCallId: 'sse_call_456',
                result: 'sse result',
                isError: true,
            });
        });

        it('should extract tool completion from SSE tool part state machine', () => {
            const event: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'tool',
                        tool: 'edit_file',
                        callID: 'tc_123',
                        state: {
                            type: 'completed',
                            output: 'ok',
                        },
                    },
                },
            };
            const result = extractToolResult(event);
            expect(result).to.deep.equal({
                toolCallId: 'tc_123',
                result: 'ok',
                isError: false,
            });
        });
    });

    describe('extractTextDelta', () => {
        it('should extract text from part.text', () => {
            const event: OpenCodeEvent = {
                type: 'text',
                part: { text: 'hello world' },
            };
            expect(extractTextDelta(event)).to.equal('hello world');
        });

        it('should extract text from event.text', () => {
            const event: OpenCodeEvent = {
                type: 'text_delta',
                text: 'delta text',
            };
            expect(extractTextDelta(event)).to.equal('delta text');
        });

        it('should extract text from SSE properties.part.text', () => {
            const event: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: {
                    sessionID: 'sess_123',
                    part: {
                        type: 'text',
                        text: 'sse text content',
                    },
                },
            };
            expect(extractTextDelta(event)).to.equal('sse text content');
        });

        it('should return null when no text present', () => {
            const event: OpenCodeEvent = { type: 'other' };
            expect(extractTextDelta(event)).to.be.null;
        });
    });

    describe('extractErrorMessage', () => {
        it('should extract error string', () => {
            const event: OpenCodeEvent = { type: 'error', error: 'something broke' };
            expect(extractErrorMessage(event)).to.equal('something broke');
        });

        it('should extract nested error message', () => {
            const event: OpenCodeEvent = {
                type: 'error',
                error: { message: 'nested error', code: 500 },
            };
            expect(extractErrorMessage(event)).to.equal('nested error');
        });

        it('should extract deeply nested error message', () => {
            const event: OpenCodeEvent = {
                type: 'error',
                error: { data: { message: 'deep error' } },
            };
            expect(extractErrorMessage(event)).to.equal('deep error');
        });

        it('should extract session.error payloads nested under properties', () => {
            const event: OpenCodeEvent = {
                type: 'session.error',
                properties: {
                    error: { data: { message: 'quota exceeded' } },
                },
            };
            expect(extractErrorMessage(event)).to.equal('quota exceeded');
        });

        it('should extract assistant completion errors nested under properties.info', () => {
            const event: OpenCodeEvent = {
                type: 'message.updated',
                properties: {
                    info: {
                        role: 'assistant',
                        error: { message: 'assistant failed' },
                    },
                },
            };
            expect(extractErrorMessage(event)).to.equal('assistant failed');
        });

        it('should return null when no error', () => {
            const event: OpenCodeEvent = { type: 'text' };
            expect(extractErrorMessage(event)).to.be.null;
        });
    });

    describe('extractRetryStatus', () => {
        it('returns the message, retry time, and attempt for a session.status retry', () => {
            const event: OpenCodeEvent = {
                type: 'session.status',
                properties: {
                    sessionID: 'ses_1',
                    status: {
                        type: 'retry',
                        attempt: 1,
                        message: 'Rate limit exceeded. Please try again later.',
                        next: 1779321600837,
                    },
                },
            };
            expect(extractRetryStatus(event)).to.deep.equal({
                message: 'Rate limit exceeded. Please try again later.',
                retryAtMs: 1779321600837,
                attempt: 1,
            });
        });

        it('omits retryAtMs and attempt when the retry status does not carry them', () => {
            const event: OpenCodeEvent = {
                type: 'session.status',
                properties: { status: { type: 'retry', message: 'Slow down.' } },
            };
            const result = extractRetryStatus(event);
            expect(result).to.not.be.null;
            expect(result?.message).to.equal('Slow down.');
            expect(result?.retryAtMs).to.be.undefined;
            expect(result?.attempt).to.be.undefined;
        });

        it('falls back to a default message when the retry status carries none', () => {
            const event: OpenCodeEvent = {
                type: 'session.status',
                properties: { status: { type: 'retry', next: 123 } },
            };
            const result = extractRetryStatus(event);
            expect(result?.message).to.equal('OpenCode reported a retry status with no message');
            expect(result?.retryAtMs).to.equal(123);
        });

        it('returns null for non-retry session.status events', () => {
            expect(extractRetryStatus({
                type: 'session.status',
                properties: { status: { type: 'busy' } },
            })).to.be.null;
            expect(extractRetryStatus({
                type: 'session.status',
                properties: { status: { type: 'idle' } },
            })).to.be.null;
        });

        it('returns null for events that are not a session.status retry', () => {
            expect(extractRetryStatus({ type: 'server.heartbeat', properties: {} })).to.be.null;
            expect(extractRetryStatus({
                type: 'message.updated',
                properties: { info: { role: 'assistant' } },
            })).to.be.null;
            expect(extractRetryStatus({ type: 'session.status' })).to.be.null;
            expect(extractRetryStatus({ type: 'session.status', properties: {} })).to.be.null;
        });
    });

    describe('isCompletionEvent', () => {
        it('should return true for completion types', () => {
            expect(isCompletionEvent({ type: 'step_end' })).to.be.true;
            expect(isCompletionEvent({ type: 'message_end' })).to.be.true;
            expect(isCompletionEvent({ type: 'done' })).to.be.true;
            expect(isCompletionEvent({ type: 'complete' })).to.be.true;
            expect(isCompletionEvent({ type: 'finish' })).to.be.true;
        });

        it('should return false for non-completion types', () => {
            expect(isCompletionEvent({ type: 'text' })).to.be.false;
            expect(isCompletionEvent({ type: 'tool_call' })).to.be.false;
            expect(isCompletionEvent({})).to.be.false;
        });

        it('should return true for hard OpenCode SSE completion types', () => {
            // Only explicit "the model is done" signals advance to applying_patch.
            expect(isCompletionEvent({ type: 'session.end' })).to.be.true;
            expect(isCompletionEvent({ type: 'session.done' })).to.be.true;
        });

        it('should return false for soft-close OpenCode SSE types (preservation invariant)', () => {
            // These mean "the wire went quiet", not "the model is done". The session
            // layer maps them to TRANSPORT_CLOSED; if no hard terminal was seen, the
            // file is preserved instead of being overwritten with partial output.
            expect(isCompletionEvent({ type: 'session.idle' })).to.be.false;
            expect(isCompletionEvent({ type: 'session.error' })).to.be.false;
            expect(isCompletionEvent({ type: 'server.disconnect' })).to.be.false;
            expect(isCompletionEvent({ type: 'end' })).to.be.false;
        });

        it('should return false for server.heartbeat', () => {
            expect(isCompletionEvent({ type: 'server.heartbeat' })).to.be.false;
            expect(isCompletionEvent({ type: 'server.heartbeat', properties: {} })).to.be.false;
        });

        it('should return true for message.updated with info.time.completed', () => {
            const completedEvent: OpenCodeEvent = {
                type: 'message.updated',
                properties: {
                    info: {
                        role: 'assistant',
                        time: { completed: 1735080000000 },
                    },
                },
            };
            expect(isCompletionEvent(completedEvent)).to.be.true;
        });

        it('should return false for message.updated without completed time', () => {
            expect(isCompletionEvent({
                type: 'message.updated',
                properties: { info: { role: 'assistant', time: {} } },
            })).to.be.false;
            expect(isCompletionEvent({
                type: 'message.updated',
                properties: { info: { role: 'assistant', time: { completed: 0 } } },
            })).to.be.false;
            expect(isCompletionEvent({
                type: 'message.updated',
                properties: {},
            })).to.be.false;
        });

        it('should return false for user message.updated even when completed is set', () => {
            expect(isCompletionEvent({
                type: 'message.updated',
                properties: { info: { role: 'user', time: { completed: 1735080000000 } } },
            })).to.be.false;
        });
    });

    describe('extractAssistantFinishReason', () => {
        it('should extract tool-calls from assistant message.updated', () => {
            const event: OpenCodeEvent = {
                type: 'message.updated',
                properties: {
                    info: {
                        role: 'assistant',
                        finish: 'tool-calls',
                        time: { completed: 1735080000000 },
                    },
                },
            };
            expect(extractAssistantFinishReason(event)).to.equal('tool-calls');
        });

        it('should extract stop from assistant message.updated', () => {
            const event: OpenCodeEvent = {
                type: 'message.updated',
                properties: {
                    info: {
                        role: 'assistant',
                        finish: 'stop',
                        time: { completed: 1735080000000 },
                    },
                },
            };
            expect(extractAssistantFinishReason(event)).to.equal('stop');
        });

        it('should return null when finish is missing', () => {
            const event: OpenCodeEvent = {
                type: 'message.updated',
                properties: {
                    info: {
                        role: 'assistant',
                        time: { completed: 1735080000000 },
                    },
                },
            };
            expect(extractAssistantFinishReason(event)).to.be.null;
        });

        it('should identify tool-call continuation boundaries', () => {
            const toolBoundary: OpenCodeEvent = {
                type: 'message.updated',
                properties: {
                    info: {
                        role: 'assistant',
                        finish: 'tool-calls',
                        time: { completed: 1735080000000 },
                    },
                },
            };
            const stopBoundary: OpenCodeEvent = {
                type: 'message.updated',
                properties: {
                    info: {
                        role: 'assistant',
                        finish: 'stop',
                        time: { completed: 1735080000000 },
                    },
                },
            };
            expect(isToolCallContinuationBoundary(toolBoundary)).to.be.true;
            expect(isToolCallContinuationBoundary(stopBoundary)).to.be.false;
        });
    });

    describe('safeParseParams', () => {
        it('should parse string JSON', () => {
            expect(safeParseParams('{"a":1}')).to.deep.equal({ a: 1 });
        });

        it('should return object as-is', () => {
            const obj = { a: 1 };
            expect(safeParseParams(obj)).to.equal(obj);
        });

        it('should return empty object for invalid input', () => {
            expect(safeParseParams(null)).to.deep.equal({});
            expect(safeParseParams(42)).to.deep.equal({});
            expect(safeParseParams('not json')).to.deep.equal({ raw: 'not json' });
        });
    });

    describe('resolveToolName', () => {
        it('should resolve name from various fields', () => {
            expect(resolveToolName({ name: 'a' })).to.equal('a');
            expect(resolveToolName({ toolName: 'b' })).to.equal('b');
            expect(resolveToolName({ function: { name: 'c' } })).to.equal('c');
            expect(resolveToolName({})).to.be.undefined;
            expect(resolveToolName(null)).to.be.undefined;
        });
    });

    describe('resolveToolParams', () => {
        it('should resolve params from arguments field', () => {
            expect(resolveToolParams({ arguments: '{"x":1}' })).to.deep.equal({ x: 1 });
        });

        it('should resolve params from args field', () => {
            expect(resolveToolParams({ args: '{"y":2}' })).to.deep.equal({ y: 2 });
        });

        it('should return empty object for non-object input', () => {
            expect(resolveToolParams(null)).to.deep.equal({});
            expect(resolveToolParams('string')).to.deep.equal({});
        });
    });

    describe('resolveToolCallId', () => {
        it('should resolve id from various fields', () => {
            expect(resolveToolCallId({ id: 'a' })).to.equal('a');
            expect(resolveToolCallId({ toolCallId: 'b' })).to.equal('b');
            expect(resolveToolCallId({ tool_call_id: 'c' })).to.equal('c');
            expect(resolveToolCallId({})).to.be.undefined;
        });
    });

    describe('resolveResultValue', () => {
        it('should resolve string result', () => {
            expect(resolveResultValue({ result: 'ok' })).to.equal('ok');
        });

        it('should stringify non-string result', () => {
            expect(resolveResultValue({ output: { key: 'val' } })).to.equal('{"key":"val"}');
        });

        it('should return empty string for missing result', () => {
            expect(resolveResultValue({})).to.equal('');
        });
    });

    describe('event type predicates', () => {
        it('isToolCallEvent matches correctly', () => {
            expect(isToolCallEvent({ type: 'tool_call' })).to.be.true;
            expect(isToolCallEvent({ type: 'tool-call' })).to.be.true;
            expect(isToolCallEvent({ type: 'other' })).to.be.false;
            expect(isToolCallEvent(null)).to.be.false;
        });

        it('isToolResultEvent matches correctly', () => {
            expect(isToolResultEvent({ type: 'tool_result' })).to.be.true;
            expect(isToolResultEvent({ type: 'tool-result' })).to.be.true;
            expect(isToolResultEvent({ type: 'other' })).to.be.false;
        });

        it('isToolUseEvent matches correctly', () => {
            expect(isToolUseEvent({ type: 'tool_use' })).to.be.true;
            expect(isToolUseEvent({ type: 'other' })).to.be.false;
        });

        it('isToolCallPart matches correctly', () => {
            expect(isToolCallPart({ type: 'tool_call' })).to.be.true;
            expect(isToolCallPart({ type: 'other' })).to.be.false;
        });

        it('isToolResultPart matches correctly', () => {
            expect(isToolResultPart({ type: 'tool_result' })).to.be.true;
            expect(isToolResultPart({ type: 'other' })).to.be.false;
        });

        it('isToolUsePart matches correctly', () => {
            expect(isToolUsePart({ type: 'tool' })).to.be.true;
            expect(isToolUsePart({ type: 'other' })).to.be.false;
        });
    });

    describe('session/message helpers', () => {
        it('extracts session and message metadata from wire events', () => {
            const partEvent: OpenCodeEvent = {
                type: 'message.part.updated',
                properties: {
                    sessionID: 'sess_1',
                    part: {
                        type: 'text',
                        messageID: 'msg_1',
                    },
                },
            };
            const messageEvent: OpenCodeEvent = {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'msg_1',
                        role: 'assistant',
                    },
                },
            };
            expect(extractSessionId(partEvent)).to.equal('sess_1');
            expect(extractMessageRole(messageEvent)).to.equal('assistant');
            expect(extractMessageId(messageEvent)).to.equal('msg_1');
            expect(extractPartMessageId(partEvent)).to.equal('msg_1');
        });
    });
});
