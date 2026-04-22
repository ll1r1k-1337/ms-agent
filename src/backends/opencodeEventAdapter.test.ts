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
    parseEventLine,
    extractTextDelta,
    extractErrorMessage,
    isCompletionEvent,
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

        it('should return null for non-tool event', () => {
            const event: OpenCodeEvent = { type: 'text', text: 'hello' };
            expect(extractToolCall(event)).to.be.null;
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

        it('should return null when no error', () => {
            const event: OpenCodeEvent = { type: 'text' };
            expect(extractErrorMessage(event)).to.be.null;
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
});
