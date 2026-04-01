import { Message, extractText, extractToolCalls, textMessage, assistantMessage, toolResultMessage, ToolCallContent } from './message';
import { ToolDefinition } from '../llm/provider';
import { getToolDefinitions, executeTool, ToolContext } from '../tools/toolHandlers';
import { LLMProvider } from '../llm/provider';
import { StreamChunk } from '../llm/types';

export interface AgentRunOptions {
    systemPrompt: string;
    taskDescription: string;
    toolContext: ToolContext;
    llm: LLMProvider;
    maxToolRounds?: number;
    onToolCall?: (toolName: string, params: Record<string, unknown>, toolCallId: string) => void;
    onTextResponse?: (text: string) => void;
    abortSignal?: { aborted: boolean };
    onMessageChunk?: (chunk: StreamChunk, messageId: string) => void;
    onToolResult?: (toolCallId: string, result: string, isError: boolean) => void;
    onDiff?: (path: string, oldText: string, newText: string, toolCallId: string) => void;
    useStreaming?: boolean;
}

export interface AgentResult {
    finalMessage: string;
    toolCallCount: number;
    messages: Message[];
}

const MAX_CONSECUTIVE_FAILURES = 3;

function generateToolCallId(): string {
    return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export async function runAgent(options: AgentRunOptions): Promise<AgentResult> {
    const {
        systemPrompt,
        taskDescription,
        toolContext,
        llm,
        maxToolRounds = 20,
        onToolCall,
        onTextResponse,
        onMessageChunk,
        onToolResult,
        onDiff,
        useStreaming = true,
    } = options;

    const toolDefs = getToolDefinitions();
    const messages: Message[] = [textMessage(taskDescription)];
    let toolCallCount = 0;
    let consecutiveFailures = 0;

    const supportsStreaming = useStreaming && 'streamChat' in llm && typeof (llm as any).streamChat === 'function';

    for (let round = 0; round < maxToolRounds; round++) {
        if (options.abortSignal?.aborted) {
            return {
                finalMessage: 'Aborted',
                toolCallCount,
                messages,
            };
        }

        let response;
        if (supportsStreaming) {
            response = await handleStreamingLLM(
                llm as any,
                messages,
                toolDefs,
                systemPrompt,
                onMessageChunk
            );
        } else {
            response = await llm.chat(messages, toolDefs, systemPrompt);
        }

        if (options.abortSignal?.aborted) {
            return {
                finalMessage: 'Aborted',
                toolCallCount,
                messages,
            };
        }

        messages.push(assistantMessage(response.content));

        if (response.stopReason !== 'tool_use' || response.content.length === 0) {
            const text = extractText({ role: 'assistant', content: response.content });
            if (text && onTextResponse) {
                onTextResponse(text);
            }
            if (!supportsStreaming && text && onMessageChunk) {
                const messageId = generateMessageId();
                onMessageChunk({ type: 'text_delta', delta: text }, messageId);
            }
            return {
                finalMessage: text || '(No text response from LLM)',
                toolCallCount,
                messages,
            };
        }

        for (const block of response.content) {
            if (block.type === 'tool_use') {
                if (options.abortSignal?.aborted) {
                    return {
                        finalMessage: 'Aborted',
                        toolCallCount,
                        messages,
                    };
                }

                const toolCall = block as ToolCallContent;
                toolCallCount++;

                const toolCallId = toolCall.id || generateToolCallId();

                if (onToolCall) {
                    onToolCall(toolCall.name, toolCall.input, toolCallId);
                }
                let result: string;

                try {
                    result = await executeTool(toolCall.name, toolCall.input, toolContext);
                } catch (e) {
                    result = `Error: ${e instanceof Error ? e.message : String(e)}`;
                }

                const isError = typeof result === 'string' && result.startsWith('Error');
                
                if (isError) {
                    consecutiveFailures++;
                    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        messages.push(toolResultMessage(toolCallId, result, true));
                        return {
                            finalMessage: `Agent stopped after ${consecutiveFailures} consecutive failures. Last error: ${result}`,
                            toolCallCount,
                            messages,
                        };
                    }
                } else {
                    consecutiveFailures = 0;
                }
                
                if (onToolResult) {
                    onToolResult(toolCallId, result, isError);
                }

                if (toolCall.name === 'edit_file' && onDiff && !isError) {
                    const input = toolCall.input as any;
                    if (input.path && input.oldText !== undefined && input.newText !== undefined) {
                        onDiff(input.path, input.oldText, input.newText, toolCallId);
                    }
                }

                if (isError && result.startsWith('Error: Unknown tool')) {
                    messages.push(toolResultMessage(toolCallId, result, true));
                    continue;
                }

                messages.push(toolResultMessage(toolCallId, result, isError));
            }
        }

        if (messages.length > 100) {
            const toRemove = messages.length - 100;
            for (let i = 0; i < toRemove && i < messages.length; i++) {
                if (messages[i].role !== 'system') {
                    messages.splice(i, 1);
                    i--;
                }
            }
        }
    }

    const text = extractText(messages[messages.length - 1] || { role: 'assistant', content: [] });
    return {
        finalMessage: text || `Agent stopped after ${maxToolRounds} tool rounds.`,
        toolCallCount,
        messages,
    };
}

async function handleStreamingLLM(
    llm: { streamChat: (messages: Message[], tools: ToolDefinition[], systemPrompt?: string) => AsyncGenerator<StreamChunk> },
    messages: Message[],
    tools: ToolDefinition[],
    systemPrompt: string | undefined,
    onMessageChunk?: (chunk: StreamChunk, messageId: string) => void
): Promise<{ content: any[]; stopReason: string }> {
    const messageId = generateMessageId();
    const content: any[] = [];
    let accumulatedText = '';
    const toolCalls = new Map<string, { id: string; name: string; input: string | Record<string, unknown> }>();

    try {
        for await (const chunk of llm.streamChat(messages, tools, systemPrompt)) {
            if (onMessageChunk) {
                onMessageChunk(chunk, messageId);
            }

            if (chunk.type === 'text_delta' && chunk.delta) {
                accumulatedText += chunk.delta;
            }

            if (chunk.type === 'tool_use_start' && chunk.toolCall) {
                toolCalls.set(chunk.toolCall.id, {
                    id: chunk.toolCall.id,
                    name: chunk.toolCall.name || '',
                    input: chunk.toolCall.input || ''
                });
            }

            if (chunk.type === 'tool_use_delta' && chunk.toolCall) {
                const tc = toolCalls.get(chunk.toolCall.id);
                if (tc && chunk.toolCall.inputDelta && typeof tc.input === 'string') {
                    tc.input += chunk.toolCall.inputDelta;
                }
            }

            if (chunk.type === 'done') {
                break;
            }

            if (chunk.type === 'error') {
                throw new Error(chunk.error || 'Streaming error');
            }
        }
    } catch (e) {
        throw e;
    }

    if (accumulatedText) {
        content.push({ type: 'text', text: accumulatedText });
    }

    for (const tc of toolCalls.values()) {
        let parsedInput: any = {};
        if (typeof tc.input === 'object') {
            parsedInput = tc.input;
        } else if (typeof tc.input === 'string' && tc.input) {
            try {
                parsedInput = JSON.parse(tc.input);
            } catch {
                parsedInput = { _raw: tc.input };
            }
        }
        content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: parsedInput
        });
    }

    return {
        content,
        stopReason: toolCalls.size > 0 ? 'tool_use' : 'end_turn'
    };
}
