import * as fs from 'fs';
import { FixResult } from './fixBackend';
import { OpenCodeTransport } from './opencodeTransport';
import { executeTool, ToolContext } from '../tools/toolHandlers';
import { StreamChunk } from '../llm/types';
import {
    extractToolCall,
    extractToolResult,
    extractTextDelta,
    extractErrorMessage,
    isCompletionEvent,
    ToolCallInfo,
    ToolResultInfo,
    OpenCodeEvent,
} from './opencodeEventAdapter';

export interface OpenCodeSessionCallbacks {
    onMessageChunk?: (chunk: StreamChunk, messageId: string) => void;
    onToolCall?: (name: string, params: Record<string, unknown>, toolCallId: string) => void;
    onToolResult?: (toolCallId: string, result: string, isError: boolean) => void;
    onDiff?: (filePath: string, oldText: string, newText: string, toolCallId: string) => void;
}

export class OpenCodeSession {
    private transport: OpenCodeTransport;
    private callbacks?: OpenCodeSessionCallbacks;
    private abortController: AbortController;
    private cancelled = false;

    constructor(transport: OpenCodeTransport, callbacks?: OpenCodeSessionCallbacks) {
        this.transport = transport;
        this.callbacks = callbacks;
        this.abortController = new AbortController();
    }

    cancel(): void {
        this.cancelled = true;
        this.transport.cancel();
        this.abortController.abort();
    }

    async run(options: {
        prompt: string;
        workspaceRoot: string;
        resolvedPath: string;
        originalContent: string;
        timeoutMs: number;
        messageId?: string;
    }): Promise<FixResult> {
        if (this.cancelled) {
            return {
                success: false,
                finalMessage: 'Fix cancelled by user',
                toolCallCount: 0,
                fileChanged: false,
            };
        }

        const messageId = options.messageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        return new Promise<FixResult>((resolve) => {
            let parsedText = '';
            const errorMessages: string[] = [];
            let toolCallCount = 0;
            let finalized = false;
            let transportError: Error | null = null;

            const toolContext: ToolContext = {
                workspaceRoot: options.workspaceRoot,
            };

            const doResolve = (result: FixResult): void => {
                if (finalized) {
                    return;
                }
                finalized = true;
                clearTimeout(timeoutId);
                resolve(result);
            };

            const finalize = (): void => {
                if (this.cancelled || this.abortController.signal.aborted) {
                    doResolve({
                        success: false,
                        finalMessage: 'Fix cancelled by user',
                        toolCallCount,
                        fileChanged: false,
                    });
                    return;
                }

                if (transportError) {
                    doResolve({
                        success: false,
                        finalMessage: `Transport error: ${transportError.message}`,
                        toolCallCount,
                        fileChanged: false,
                    });
                    return;
                }

                if (errorMessages.length > 0) {
                    doResolve({
                        success: false,
                        finalMessage: errorMessages.join('; '),
                        toolCallCount,
                        fileChanged: false,
                    });
                    return;
                }

                const codeMatch = parsedText.match(/```(?:cpp|c\+\+|c)?\s*\n?([\s\S]*?)```/);
                if (!codeMatch) {
                    doResolve({
                        success: false,
                        finalMessage: 'OpenCode did not return a valid code block. The response may not have contained the fixed file content.',
                        toolCallCount,
                        fileChanged: false,
                    });
                    return;
                }

                const fixedCode = codeMatch[1].trim();
                const normalizedOriginal = options.originalContent.replace(/\r\n/g, '\n').trim();
                const normalizedFixed = fixedCode.replace(/\r\n/g, '\n').trim();

                if (normalizedOriginal === normalizedFixed) {
                    doResolve({
                        success: false,
                        finalMessage: 'OpenCode returned the same code. No changes were made.',
                        toolCallCount,
                        fileChanged: false,
                    });
                    return;
                }

                fs.writeFileSync(options.resolvedPath, fixedCode, 'utf-8');
                this.callbacks?.onDiff?.(options.resolvedPath, options.originalContent, fixedCode, 'opencode_fix');

                doResolve({
                    success: true,
                    finalMessage: 'Fix applied successfully using OpenCode.',
                    toolCallCount,
                    fileChanged: true,
                    originalContent: options.originalContent,
                    newContent: fixedCode,
                });
            };

            const timeoutId = setTimeout(() => {
                this.cancel();
                doResolve({
                    success: false,
                    finalMessage: `Fix timed out after ${options.timeoutMs}ms`,
                    toolCallCount,
                    fileChanged: false,
                });
            }, options.timeoutMs);

            this.abortController.signal.addEventListener('abort', () => {
                doResolve({
                    success: false,
                    finalMessage: 'Fix cancelled by user',
                    toolCallCount,
                    fileChanged: false,
                });
            });

            this.transport.onEvent((event: unknown) => {
                if (finalized) {
                    return;
                }

                const e = event as OpenCodeEvent;

                const textDelta = extractTextDelta(e);
                if (textDelta) {
                    parsedText += textDelta;
                    this.callbacks?.onMessageChunk?.({ type: 'text_delta', delta: textDelta }, messageId);
                }

                const errorMsg = extractErrorMessage(e);
                if (errorMsg) {
                    errorMessages.push(errorMsg);
                    this.callbacks?.onMessageChunk?.(
                        { type: 'text_delta', delta: `\n❌ OpenCode error: ${errorMsg}\n` },
                        messageId,
                    );
                }

                const toolCallInfo: ToolCallInfo | null = extractToolCall(e);
                if (toolCallInfo) {
                    toolCallCount++;
                    const toolCallId = toolCallInfo.toolCallId || `tc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    this.callbacks?.onToolCall?.(toolCallInfo.name, toolCallInfo.params, toolCallId);

                    void (async (): Promise<void> => {
                        const result = await executeTool(toolCallInfo.name, toolCallInfo.params, toolContext);
                        const isError = result.startsWith('Error:');

                        this.transport.send({
                            type: 'tool_result',
                            tool_result: { toolCallId, result, isError },
                        });

                        this.callbacks?.onToolResult?.(toolCallId, result, isError);

                        if (isError) {
                            const errText = `Tool ${toolCallInfo.name} failed: ${result}`;
                            errorMessages.push(errText);
                            this.callbacks?.onMessageChunk?.(
                                { type: 'text_delta', delta: `\n⚠️ ${errText}\n` },
                                messageId,
                            );
                        }
                    })();
                }

                const toolResultInfo: ToolResultInfo | null = extractToolResult(e);
                if (toolResultInfo) {
                    this.callbacks?.onToolResult?.(
                        toolResultInfo.toolCallId,
                        toolResultInfo.result,
                        toolResultInfo.isError,
                    );
                    if (toolResultInfo.isError) {
                        errorMessages.push(`Tool failed: ${toolResultInfo.result}`);
                    }
                }

                if (isCompletionEvent(e)) {
                    finalize();
                }
            });

            this.transport.onClose((_exitCode: number | null) => {
                finalize();
            });

            this.transport.onError((error: Error) => {
                transportError = error;
                finalize();
            });

            this.transport.start(options.prompt);
        });
    }
}
