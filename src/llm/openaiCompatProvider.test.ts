import { expect } from 'chai';
import * as http from 'http';
import { OpenAICompatProvider, LLMProviderError } from './openaiCompatProvider';
import { textMessage } from '../agent/message';
import { ToolDefinition } from './provider';

describe('OpenAICompatProvider', () => {
    const baseConfig = {
        endpoint: 'http://localhost:11434',
        modelName: 'test-model',
        temperature: 0.1,
        maxTokens: 1024,
        timeoutMs: 5000,
    };

    const tools: ToolDefinition[] = [
        { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    ];

    describe('constructor', () => {
        it('should apply default values for optional fields', () => {
            const provider = new OpenAICompatProvider({ endpoint: 'http://x', modelName: 'm' });
            expect(provider).to.be.instanceOf(OpenAICompatProvider);
        });
    });

    describe('chat', () => {
        let server: http.Server;
        let lastBody: any;

        before((done) => {
            server = http.createServer((req, res) => {
                let data = '';
                req.on('data', chunk => { data += chunk; });
                req.on('end', () => {
                    lastBody = JSON.parse(data);
                    const url = req.url || '';
                    if (url.includes('fail-500')) {
                        res.writeHead(500);
                        res.end('Internal Server Error');
                        return;
                    }
                    if (url.includes('invalid-json')) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end('not json');
                        return;
                    }
                    if (url.includes('empty-choices')) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ choices: [] }));
                        return;
                    }
                    if (url.includes('with-tools')) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            choices: [{
                                message: {
                                    content: 'I will read the file',
                                    tool_calls: [{
                                        type: 'function',
                                        id: 'tc_1',
                                        function: { name: 'read_file', arguments: '{"path":"test.cpp"}' },
                                    }],
                                },
                                finish_reason: 'tool_calls',
                            }],
                            usage: { prompt_tokens: 10, completion_tokens: 20 },
                        }));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        choices: [{
                            message: { content: 'Hello from LLM' },
                            finish_reason: 'stop',
                        }],
                        usage: { prompt_tokens: 5, completion_tokens: 10 },
                    }));
                });
            });
            server.listen(18765, done);
        });

        after((done) => {
            server.close(done);
        });

        it('should send request and parse text response', async () => {
            const provider = new OpenAICompatProvider({
                ...baseConfig,
                endpoint: 'http://localhost:18765',
            });
            const result = await provider.chat([textMessage('hi')], []);
            expect(result.stopReason).to.equal('end_turn');
            expect(result.content).to.have.length(1);
            expect(result.content[0].type).to.equal('text');
            if (result.content[0].type === 'text') {
                expect(result.content[0].text).to.equal('Hello from LLM');
            }
            expect(result.usage).to.deep.equal({ promptTokens: 5, completionTokens: 10 });
        });

        it('should send correct model and messages in request body', async () => {
            const provider = new OpenAICompatProvider({
                ...baseConfig,
                endpoint: 'http://localhost:18765',
            });
            await provider.chat([textMessage('test')], []);
            expect(lastBody.model).to.equal('test-model');
            expect(lastBody.messages).to.have.length(1);
            expect(lastBody.messages[0].role).to.equal('user');
            expect(lastBody.messages[0].content).to.equal('test');
        });

        it('should parse tool call responses', async () => {
            const provider = new OpenAICompatProvider({
                ...baseConfig,
                endpoint: 'http://localhost:18765/with-tools',
            });
            const result = await provider.chat([textMessage('read the file')], tools);
            expect(result.stopReason).to.equal('tool_use');
            const toolCalls = result.content.filter(c => c.type === 'tool_use');
            expect(toolCalls).to.have.length(1);
            if (toolCalls[0].type === 'tool_use') {
                expect(toolCalls[0].name).to.equal('read_file');
                expect(toolCalls[0].input).to.deep.equal({ path: 'test.cpp' });
            }
        });

        it('should handle empty choices', async () => {
            const provider = new OpenAICompatProvider({
                ...baseConfig,
                endpoint: 'http://localhost:18765/empty-choices',
            });
            const result = await provider.chat([textMessage('hi')], []);
            expect(result.content).to.be.empty;
            expect(result.stopReason).to.equal('end_turn');
        });

        it('should throw LLMProviderError on HTTP 500', async () => {
            const provider = new OpenAICompatProvider({
                ...baseConfig,
                endpoint: 'http://localhost:18765/fail-500',
            });
            try {
                await provider.chat([textMessage('hi')], []);
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e).to.be.instanceOf(LLMProviderError);
                expect((e as LLMProviderError).code).to.equal('HTTP_ERROR');
            }
        });

        it('should throw LLMProviderError on invalid JSON', async () => {
            const provider = new OpenAICompatProvider({
                ...baseConfig,
                endpoint: 'http://localhost:18765/invalid-json',
            });
            try {
                await provider.chat([textMessage('hi')], []);
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e).to.be.instanceOf(LLMProviderError);
                expect((e as LLMProviderError).code).to.equal('INVALID_RESPONSE');
            }
        });

        it('should throw CONNECTION_REFUSED on connection failure', async () => {
            const provider = new OpenAICompatProvider({
                ...baseConfig,
                endpoint: 'http://localhost:19999',
                timeoutMs: 2000,
            });
            try {
                await provider.chat([textMessage('hi')], []);
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e).to.be.instanceOf(LLMProviderError);
                expect((e as LLMProviderError).code).to.equal('CONNECTION_REFUSED');
            }
        });

        it('should include Authorization header when apiKey is set', async () => {
            const provider = new OpenAICompatProvider({
                ...baseConfig,
                endpoint: 'http://localhost:18765',
                apiKey: 'sk-test-key',
            });
            const result = await provider.chat([textMessage('hi')], []);
            expect(result.stopReason).to.equal('end_turn');
        });
    });
});
