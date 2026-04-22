import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import {
    LLMProvider, LLMResponse, ToolDefinition, toApiTool, toApiMessages
} from './provider';
import { Message } from '../agent/message';
import { ContentBlock, extractText, extractToolCalls, ToolCallContent } from '../agent/message';
import { StreamChunk } from './types';

// Robust error type for LLM provider failures
export type LLMProviderErrorCode = 'CONNECTION_REFUSED' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'UNKNOWN_TOOL' | 'HTTP_ERROR';

export class LLMProviderError extends Error {
    code: LLMProviderErrorCode;
    constructor(message: string, code: LLMProviderErrorCode) {
        super(message);
        this.name = 'LLMProviderError';
        this.code = code;
    }
}

export interface OpenAICompatConfig {
    endpoint: string;
    modelName: string;
    apiKey?: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
}

interface OpenAIMessage {
    role: string;
    content?: string | unknown[];
    tool_calls?: Array<{
        type: string;
        id: string;
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
}

interface OpenAIResponse {
    choices: Array<{
        message: OpenAIMessage;
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
    };
}

interface StreamingToolCallBuffer {
    id: string;
    name?: string;
    arguments: string;
}

function httpRequest(url: string, body: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        const req = client.request(
            {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                timeout: timeoutMs,
            },
            (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    // Successful HTTP response
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(new LLMProviderError(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`, 'HTTP_ERROR'));
                    }
                });
            },
        );

        req.on('error', (err: any) => {
            if (err && err.code === 'ECONNREFUSED') {
                reject(new LLMProviderError('Connection refused. Is the LLM server running?', 'CONNECTION_REFUSED'));
            } else {
                reject(new LLMProviderError(`HTTP error: ${err?.message || 'unknown'}`, 'HTTP_ERROR'));
            }
        });
        req.on('timeout', () => { req.destroy(); reject(new LLMProviderError('LLM request timed out. Consider increasing timeoutMs.', 'TIMEOUT')); });
        req.write(body);
        req.end();
    });
}

export class OpenAICompatProvider implements LLMProvider {
    private config: OpenAICompatConfig;

    constructor(config: OpenAICompatConfig) {
        this.config = {
            timeoutMs: 300000,
            temperature: 0.1,
            maxTokens: 4096,
            ...config,
        };
    }

    async chat(
        messages: Message[],
        tools: ToolDefinition[],
        systemPrompt?: string,
    ): Promise<LLMResponse> {
        const endpoint = this.config.endpoint.replace(/\/$/, '');
        const url = `${endpoint}/v1/chat/completions`;
        const apiTools = tools.length > 0 ? toApiTool(tools) : undefined;
        const apiMessages = toApiMessages(messages, systemPrompt);

        const body = JSON.stringify({
            model: this.config.modelName,
            messages: apiMessages,
            tools: apiTools,
            temperature: this.config.temperature,
            max_tokens: this.config.maxTokens,
        });

        const raw = await httpRequest(url, body, this.config.timeoutMs || 300000);
        let parsed: OpenAIResponse;
        try {
            parsed = JSON.parse(raw) as OpenAIResponse;
        } catch (e) {
            throw new LLMProviderError(`Invalid JSON response from LLM: ${raw.substring(0, 200)}`, 'INVALID_RESPONSE');
        }

        if (!parsed.choices) {
            throw new LLMProviderError('Invalid response from LLM: missing choices', 'INVALID_RESPONSE');
        }
        if (parsed.choices.length === 0) {
            return { content: [], stopReason: 'end_turn' };
        }

        const choice = parsed.choices[0];
        const content: ContentBlock[] = [];

        const reasoningContent = (choice?.message as any)?.reasoning;
        if (typeof reasoningContent === 'string' && reasoningContent.trim()) {
            content.push({ type: 'text', text: `[Thinking]\n${reasoningContent.trim()}` });
        }

        const textContent = choice?.message?.content;
        if (typeof textContent === 'string' && textContent.trim()) {
            content.push({ type: 'text', text: textContent });
        } else if (Array.isArray(textContent)) {
            for (const item of textContent) {
                if (typeof item === 'object' && item && (item as any).type === 'text' && typeof (item as any).text === 'string') {
                    content.push({ type: 'text', text: (item as any).text });
                }
            }
        }

        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
            for (let i = 0; i < choice.message.tool_calls.length; i++) {
                const tc = choice.message.tool_calls[i];
                let parsedInput: any = {};
                if (tc?.function?.arguments) {
                    const args = tc.function.arguments;
                    if (typeof args === 'object') {
                        parsedInput = args;
                    } else if (typeof args === 'string') {
                        try {
                            parsedInput = JSON.parse(args);
                        } catch {
                            parsedInput = { _raw: args };
                        }
                    }
                }
                content.push({
                    type: 'tool_use',
                    id: tc.id || `tc_${Date.now()}_${i}`,
                    name: tc.function.name,
                    input: parsedInput,
                });
            }
        }

        let stopReason: LLMResponse['stopReason'] = 'end_turn';
        if (choice.finish_reason === 'tool_calls' || choice.message.tool_calls?.length) {
            stopReason = 'tool_use';
        } else if (choice.finish_reason === 'length') {
            stopReason = 'max_tokens';
        }

        return {
            content,
            stopReason,
            usage: parsed.usage
                ? { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens }
                : undefined,
        };
    }

    async *streamChat(
        messages: Message[],
        tools: ToolDefinition[],
        systemPrompt?: string,
        abortSignal?: { aborted: boolean },
    ): AsyncGenerator<StreamChunk> {
        const endpoint = this.config.endpoint.replace(/\/$/, '');
        const url = `${endpoint}/v1/chat/completions`;
        const apiTools = tools.length > 0 ? toApiTool(tools) : undefined;
        const apiMessages = toApiMessages(messages, systemPrompt);

        const body = JSON.stringify({
            model: this.config.modelName,
            messages: apiMessages,
            tools: apiTools,
            temperature: this.config.temperature,
            max_tokens: this.config.maxTokens,
            stream: true,
        });

        const parsedUrl = new URL(url);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const chunks: StreamChunk[] = [];
        let resolveNext: ((value: IteratorResult<StreamChunk>) => void) | null = null;
        let rejectNext: ((error: any) => void) | null = null;
        let done = false;
        let abortPollTimer: ReturnType<typeof setInterval> | undefined;
        let req: http.ClientRequest | undefined;

        const closeForAbort = () => {
            if (done) {
                return;
            }
            done = true;
            req?.destroy();
            if (resolveNext) {
                resolveNext({ value: { type: 'done' }, done: false });
                resolveNext = null;
            } else {
                chunks.push({ type: 'done' });
            }
        };

        if (abortSignal) {
            abortPollTimer = setInterval(() => {
                if (abortSignal.aborted) {
                    closeForAbort();
                }
            }, 50);
        }

        req = client.request(
            {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                timeout: this.config.timeoutMs || 300000,
            },
            (res) => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    if (abortPollTimer) {
                        clearInterval(abortPollTimer);
                        abortPollTimer = undefined;
                    }
                    const err = new LLMProviderError(`HTTP ${res.statusCode}`, 'HTTP_ERROR');
                    if (rejectNext) rejectNext(err);
                    else chunks.push({ type: 'error', error: err.message });
                    done = true;
                    return;
                }

                const toolCallBuffers = new Map<string, StreamingToolCallBuffer>();
                let buffer = '';

                res.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString('utf-8');
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('data: ')) continue;

                        const data = trimmed.slice(6);
                        if (data === '[DONE]') {
                            const chunk: StreamChunk = { type: 'done' };
                            if (resolveNext) {
                                resolveNext({ value: chunk, done: false });
                                resolveNext = null;
                            } else {
                                chunks.push(chunk);
                            }
                            done = true;
                            return;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            const delta = parsed.choices?.[0]?.delta;
                            if (!delta) continue;

                            if (delta.reasoning) {
                                const chunk: StreamChunk = { type: 'text_delta', delta: delta.reasoning };
                                if (resolveNext) {
                                    resolveNext({ value: chunk, done: false });
                                    resolveNext = null;
                                } else {
                                    chunks.push(chunk);
                                }
                            }

                            if (delta.content) {
                                const chunk: StreamChunk = { type: 'text_delta', delta: delta.content };
                                if (resolveNext) {
                                    resolveNext({ value: chunk, done: false });
                                    resolveNext = null;
                                } else {
                                    chunks.push(chunk);
                                }
                            }

                            if (delta.tool_calls) {
                                for (const tc of delta.tool_calls) {
                                    const id = tc.id || `tc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                                    const name = tc.function?.name;
                                    const args = tc.function?.arguments;

                                    let input: Record<string, unknown> | undefined = undefined;
                                    if (args) {
                                        if (typeof args === 'object') {
                                            input = args as Record<string, unknown>;
                                        } else if (typeof args === 'string') {
                                            try {
                                                input = JSON.parse(args);
                                            } catch {
                                                input = { _raw: args };
                                            }
                                        }
                                    }

                                    if (name) {
                                        toolCallBuffers.set(id, { id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) });
                                        const chunk: StreamChunk = {
                                            type: 'tool_use_start',
                                            toolCall: { id, name, input }
                                        };
                                        if (resolveNext) {
                                            resolveNext({ value: chunk, done: false });
                                            resolveNext = null;
                                        } else {
                                            chunks.push(chunk);
                                        }
                                    } else if (args && toolCallBuffers.has(id)) {
                                        const buffer = toolCallBuffers.get(id)!;
                                        const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
                                        buffer.arguments += argsStr;
                                        const chunk: StreamChunk = {
                                            type: 'tool_use_delta',
                                            toolCall: { id, inputDelta: argsStr }
                                        };
                                        if (resolveNext) {
                                            resolveNext({ value: chunk, done: false });
                                            resolveNext = null;
                                        } else {
                                            chunks.push(chunk);
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                        }
                    }
                });

                res.on('end', () => {
                    if (abortPollTimer) {
                        clearInterval(abortPollTimer);
                        abortPollTimer = undefined;
                    }
                    done = true;
                    if (resolveNext) {
                        resolveNext({ value: { type: 'done' }, done: true });
                        resolveNext = null;
                    }
                });

                res.on('error', (err) => {
                    if (abortPollTimer) {
                        clearInterval(abortPollTimer);
                        abortPollTimer = undefined;
                    }
                    if (abortSignal?.aborted) {
                        return;
                    }
                    const llmErr = new LLMProviderError(`Stream error: ${err.message}`, 'HTTP_ERROR');
                    if (rejectNext) rejectNext(llmErr);
                    else chunks.push({ type: 'error', error: llmErr.message });
                    done = true;
                });
            }
        );

        req.on('error', (err: any) => {
            if (abortPollTimer) {
                clearInterval(abortPollTimer);
                abortPollTimer = undefined;
            }
            if (abortSignal?.aborted) {
                return;
            }
            const code = err?.code === 'ECONNREFUSED' ? 'CONNECTION_REFUSED' : 'HTTP_ERROR';
            const message = code === 'CONNECTION_REFUSED'
                ? 'Connection refused. Is the LLM server running?'
                : `HTTP error: ${err?.message || 'unknown'}`;
            const llmErr = new LLMProviderError(message, code);
            if (rejectNext) rejectNext(llmErr);
            else chunks.push({ type: 'error', error: llmErr.message });
            done = true;
        });

        req.on('timeout', () => {
            if (abortPollTimer) {
                clearInterval(abortPollTimer);
                abortPollTimer = undefined;
            }
            req.destroy();
            const llmErr = new LLMProviderError('LLM request timed out.', 'TIMEOUT');
            if (rejectNext) rejectNext(llmErr);
            else chunks.push({ type: 'error', error: llmErr.message });
            done = true;
        });

        req.write(body);
        req.end();

        while (!done || chunks.length > 0) {
            if (chunks.length > 0) {
                yield chunks.shift()!;
            } else {
                yield await new Promise<StreamChunk>((resolve, reject) => {
                    resolveNext = (result) => resolve(result.value);
                    rejectNext = reject;
                });
            }
        }
        if (abortPollTimer) {
            clearInterval(abortPollTimer);
            abortPollTimer = undefined;
        }
    }
}
