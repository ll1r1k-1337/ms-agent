import { expect } from 'chai';
import { toApiTool, toApiMessages } from './provider';
import { ToolDefinition } from './provider';
import { textMessage, assistantMessage, toolResultMessage } from '../agent/message';

describe('provider utilities', () => {
    describe('toApiTool', () => {
        it('should convert tool definitions to OpenAI function format', () => {
            const tools: ToolDefinition[] = [
                { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
            ];
            const result = toApiTool(tools) as any[];
            expect(result).to.have.length(1);
            expect(result[0].type).to.equal('function');
            expect(result[0].function.name).to.equal('read_file');
            expect(result[0].function.description).to.equal('Read a file');
            expect(result[0].function.parameters).to.deep.equal(tools[0].inputSchema);
        });
    });

    describe('toApiMessages', () => {
        it('should prepend system prompt as system message', () => {
            const result = toApiMessages([textMessage('hi')], 'You are helpful') as any[];
            expect(result[0].role).to.equal('system');
            expect(result[0].content).to.equal('You are helpful');
        });

        it('should convert user message', () => {
            const result = toApiMessages([textMessage('hello')]) as any[];
            expect(result[0].role).to.equal('user');
            expect(result[0].content).to.equal('hello');
        });

        it('should convert assistant message with tool calls', () => {
            const msg = assistantMessage([
                { type: 'text', text: 'fixing...' },
                { type: 'tool_use', id: 'tc_1', name: 'edit_file', input: { path: 'a.cpp' } },
            ]);
            const result = toApiMessages([msg]) as any[];
            expect(result[0].role).to.equal('assistant');
            expect(result[0].content).to.equal('fixing...');
            expect(result[0].tool_calls).to.have.length(1);
            expect(result[0].tool_calls[0].id).to.equal('tc_1');
            expect(result[0].tool_calls[0].function.name).to.equal('edit_file');
        });

        it('should convert tool result message', () => {
            const msg = toolResultMessage('tc_1', 'file contents');
            const result = toApiMessages([msg]) as any[];
            expect(result[0].role).to.equal('tool');
            expect(result[0].tool_call_id).to.equal('tc_1');
            expect(result[0].content).to.equal('file contents');
        });
    });
});
