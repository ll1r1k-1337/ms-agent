import {
    ContentBlock, Message, ToolCallContent, extractText, extractToolCalls
} from '../agent/message';

export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface LLMResponse {
    content: ContentBlock[];
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
    usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMProvider {
    chat(
        messages: Message[],
        tools: ToolDefinition[],
        systemPrompt?: string,
    ): Promise<LLMResponse>;
}

export function toApiTool(tools: ToolDefinition[]): unknown[] {
    return tools.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        },
    }));
}

export function toApiMessages(
    messages: Message[],
    systemPrompt?: string,
): unknown[] {
    const apiMessages: unknown[] = [];

    if (systemPrompt) {
        apiMessages.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
        switch (msg.role) {
            case 'user': {
                const text = extractText(msg);
                if (text) {
                    apiMessages.push({ role: 'user', content: text });
                }
                break;
            }
            case 'assistant': {
                const text = extractText(msg);
                const toolCalls = extractToolCalls(msg);
                const apiMsg: Record<string, unknown> = { role: 'assistant' };
                if (text) {
                    apiMsg.content = text;
                }
                if (toolCalls.length > 0) {
                    apiMsg.tool_calls = toolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.input),
                        },
                    }));
                }
                apiMessages.push(apiMsg);
                break;
            }
            case 'tool': {
                for (const block of msg.content) {
                    if (block.type === 'tool_result') {
                        apiMessages.push({
                            role: 'tool',
                            tool_call_id: block.tool_use_id,
                            content: block.content,
                        });
                    }
                }
                break;
            }
        }
    }

    return apiMessages;
}
