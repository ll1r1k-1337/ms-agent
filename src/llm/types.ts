import { LLMProvider } from './provider';
import { Message } from '../agent/message';
import { ToolDefinition } from './provider';

export interface StreamChunk {
    type: 'text_delta' | 'tool_use_start' | 'tool_use_delta' | 'done' | 'error';
    delta?: string;
    toolCall?: {
        id: string;
        name?: string;
        input?: Record<string, unknown>;
        inputDelta?: string;
    };
    error?: string;
}

export interface StreamingLLMProvider extends LLMProvider {
    streamChat(
        messages: Message[],
        tools: ToolDefinition[],
        systemPrompt?: string
    ): AsyncGenerator<StreamChunk>;
}