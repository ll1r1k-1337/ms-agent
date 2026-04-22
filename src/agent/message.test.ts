import { expect } from 'chai';
import {
    textMessage, assistantMessage, toolResultMessage,
    extractText, extractToolCalls, extractToolResults,
    Message, TextContent, ToolCallContent, ToolResultContent,
} from './message';

describe('message', () => {
    describe('textMessage', () => {
        it('should create a user message with text content', () => {
            const msg = textMessage('hello');
            expect(msg.role).to.equal('user');
            expect(msg.content).to.have.length(1);
            expect(msg.content[0].type).to.equal('text');
            expect((msg.content[0] as TextContent).text).to.equal('hello');
        });
    });

    describe('assistantMessage', () => {
        it('should create an assistant message with content blocks', () => {
            const blocks: TextContent[] = [{ type: 'text', text: 'response' }];
            const msg = assistantMessage(blocks);
            expect(msg.role).to.equal('assistant');
            expect(msg.content).to.deep.equal(blocks);
        });
    });

    describe('toolResultMessage', () => {
        it('should create a tool result message', () => {
            const msg = toolResultMessage('tc_1', 'result data');
            expect(msg.role).to.equal('tool');
            expect(msg.content).to.have.length(1);
            const block = msg.content[0] as ToolResultContent;
            expect(block.type).to.equal('tool_result');
            expect(block.tool_use_id).to.equal('tc_1');
            expect(block.content).to.equal('result data');
            expect(block.is_error).to.not.be.true;
        });

        it('should mark error results', () => {
            const msg = toolResultMessage('tc_1', 'fail', true);
            expect((msg.content[0] as ToolResultContent).is_error).to.be.true;
        });
    });

    describe('extractText', () => {
        it('should extract text from mixed content', () => {
            const msg: Message = {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'line1' },
                    { type: 'tool_use', id: '1', name: 'read_file', input: {} },
                    { type: 'text', text: 'line2' },
                ],
            };
            expect(extractText(msg)).to.equal('line1\nline2');
        });

        it('should return empty string for no text content', () => {
            const msg: Message = {
                role: 'assistant',
                content: [{ type: 'tool_use', id: '1', name: 'read_file', input: {} }],
            };
            expect(extractText(msg)).to.equal('');
        });
    });

    describe('extractToolCalls', () => {
        it('should extract only tool_use blocks', () => {
            const msg: Message = {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'fixing...' },
                    { type: 'tool_use', id: 'tc_1', name: 'edit_file', input: { path: 'a.cpp' } },
                    { type: 'tool_use', id: 'tc_2', name: 'read_file', input: { path: 'b.cpp' } },
                ],
            };
            const calls = extractToolCalls(msg);
            expect(calls).to.have.length(2);
            expect(calls[0].name).to.equal('edit_file');
            expect(calls[1].name).to.equal('read_file');
        });
    });

    describe('extractToolResults', () => {
        it('should extract only tool_result blocks', () => {
            const msg: Message = {
                role: 'tool',
                content: [
                    { type: 'tool_result', tool_use_id: 'tc_1', content: 'file contents' },
                    { type: 'tool_result', tool_use_id: 'tc_2', content: 'error', is_error: true },
                ],
            };
            const results = extractToolResults(msg);
            expect(results).to.have.length(2);
            expect(results[0].tool_use_id).to.equal('tc_1');
            expect(results[1].is_error).to.be.true;
        });
    });
});
