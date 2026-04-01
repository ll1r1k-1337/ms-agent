export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContent {
    type: 'text';
    text: string;
}

export interface ToolCallContent {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface ToolResultContent {
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    is_error?: boolean;
}

export type ContentBlock = TextContent | ToolCallContent | ToolResultContent;

export interface Message {
    role: Role;
    content: ContentBlock[];
}

export function textMessage(text: string): Message {
    return { role: 'user', content: [{ type: 'text', text }] };
}

export function assistantMessage(content: ContentBlock[]): Message {
    return { role: 'assistant', content };
}

export function toolResultMessage(toolUseId: string, content: string, isError = false): Message {
    return {
        role: 'tool',
        content: [{
            type: 'tool_result' as const,
            tool_use_id: toolUseId,
            content,
            is_error: isError,
        }],
    };
}

export function extractText(message: Message): string {
    return message.content
        .filter((c): c is TextContent => c.type === 'text')
        .map(c => c.text)
        .join('\n');
}

export function extractToolCalls(message: Message): ToolCallContent[] {
    return message.content.filter((c): c is ToolCallContent => c.type === 'tool_use');
}

export function extractToolResults(message: Message): ToolResultContent[] {
    return message.content.filter((c): c is ToolResultContent => c.type === 'tool_result');
}
