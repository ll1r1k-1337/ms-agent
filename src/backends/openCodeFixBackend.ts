import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import { FixBackend, FixCallbacks, FixContext, FixResult } from './fixBackend';
import { SanitizerDiagnostic } from '../parser/types';
import { buildFixPrompt } from '../skills/skillLoader';
import { StreamChunk } from '../llm/types';
import { getLLMConfig } from '../llm/config';

function getOutputChannel(): { appendLine: (msg: string) => void } {
    const globalAny = global as any;
    if (globalAny.msAgentOutputChannel) {
        return globalAny.msAgentOutputChannel;
    }
    return { appendLine: (msg: string) => console.log('[OpenCodeBackend]', msg) };
}

function log(msg: string): void {
    getOutputChannel().appendLine(`[OpenCodeBackend] ${msg}`);
}

function resolveFilePath(fileName: string, workspaceRoot: string): string {
    if (path.isAbsolute(fileName) && fs.existsSync(fileName)) {
        return fileName;
    }
    return path.resolve(workspaceRoot, fileName);
}

/**
 * Build a rich prompt for OpenCode that includes the full file content
 * and clear instructions on how to fix the error.
 */
function buildOpenCodePrompt(diagnostic: SanitizerDiagnostic, fileContent: string): string {
    const fixPrompt = buildFixPrompt(diagnostic);

    return `${fixPrompt}

## Source File Content

The following is the COMPLETE content of the file that needs to be fixed.
File path: ${diagnostic.fileName}

\`\`\`cpp
${fileContent}
\`\`\`

## Your Task

1. Analyze the memory error described above in the source file
2. Identify the root cause of the error at line ${diagnostic.lineNumber}
3. Apply a MINIMAL fix that resolves the issue
4. Return the COMPLETE fixed file content inside a markdown code block
5. Do NOT make unnecessary changes to other parts of the code
6. Preserve the original file structure and formatting as much as possible

## Response Format

Please return ONLY the complete fixed file content wrapped in a markdown code block like this:

\`\`\`cpp
// ... complete fixed file content ...
\`\`\`

Do not include explanations outside the code block. The code block should contain the ENTIRE file content, ready to be written directly to the file.`;
}

/**
 * Extract code block content from OpenCode response.
 * Looks for ```cpp or ``` blocks.
 */
function extractCodeBlock(response: string): string | null {
    const cppMatch = response.match(/```(?:cpp|c\+\+|c)?\s*\n?([\s\S]*?)```/);
    if (cppMatch) {
        return cppMatch[1].trim();
    }
    return null;
}

interface ToolCallInfo {
    name: string;
    params: Record<string, unknown>;
    toolCallId?: string;
}

interface ToolResultInfo {
    toolCallId: string;
    result: string;
    isError: boolean;
}

function safeParseParams(maybeJson: unknown): Record<string, unknown> {
    if (typeof maybeJson !== 'string') {
        return (maybeJson as Record<string, unknown>) || {};
    }
    try {
        return JSON.parse(maybeJson) as Record<string, unknown>;
    } catch {
        return { raw: maybeJson };
    }
}

function resolveToolName(tc: any): string | undefined {
    return tc?.name || tc?.toolName || tc?.function?.name;
}

function resolveToolParams(tc: any): Record<string, unknown> {
    return safeParseParams(tc?.arguments || tc?.args || tc?.input || tc?.parameters || tc?.function?.arguments);
}

function resolveToolCallId(tc: any): string | undefined {
    return tc?.id || tc?.toolCallId || tc?.tool_call_id;
}

function resolveResultValue(tr: any): string {
    const raw = tr?.result ?? tr?.output ?? tr?.content ?? tr?.data;
    return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

function isToolCallEvent(event: any): boolean {
    return event?.type === 'tool_call' || event?.type === 'tool-call';
}

function isToolResultEvent(event: any): boolean {
    return event?.type === 'tool_result' || event?.type === 'tool-result';
}

function isToolUseEvent(event: any): boolean {
    return event?.type === 'tool_use';
}

function isToolCallPart(part: any): boolean {
    return part?.type === 'tool_call' || part?.type === 'tool-call';
}

function isToolResultPart(part: any): boolean {
    return part?.type === 'tool_result' || part?.type === 'tool-result';
}

function isToolUsePart(part: any): boolean {
    return part?.type === 'tool';
}

function extractToolCall(event: any): ToolCallInfo | null {
    if (!event || typeof event !== 'object') { return null; }

    if (isToolCallEvent(event)) {
        const tc = event.tool_call || event.toolCall || event.data;
        const name = resolveToolName(tc);
        if (name) {
            return { name, params: resolveToolParams(tc), toolCallId: resolveToolCallId(tc) };
        }
    }

    // OpenCode tool_use format
    if (isToolUseEvent(event)) {
        const part = event.part;
        if (isToolUsePart(part)) {
            const name = part.tool || part.toolName || part.name;
            if (name) {
                return {
                    name: String(name),
                    params: safeParseParams(part.state?.input || part.input || part.args || part.arguments),
                    toolCallId: part.callID || part.callId || part.id || 'unknown',
                };
            }
        }
    }

    const part = event.part;
    if (isToolCallPart(part)) {
        const name = resolveToolName(part);
        if (name) {
            return { name, params: resolveToolParams(part), toolCallId: resolveToolCallId(part) };
        }
    }

    if (event.toolName || event.name) {
        return {
            name: String(event.toolName || event.name),
            params: safeParseParams(event.args || event.arguments || event.input),
            toolCallId: event.toolCallId || event.id || event.tool_call_id,
        };
    }

    return null;
}

function extractToolResult(event: any): ToolResultInfo | null {
    if (!event || typeof event !== 'object') { return null; }

    if (isToolResultEvent(event)) {
        const tr = event.tool_result || event.toolResult || event.data;
        if (tr) {
            return {
                toolCallId: String(tr.toolCallId || tr.id || tr.tool_call_id || 'unknown'),
                result: resolveResultValue(tr),
                isError: !!(tr.isError || tr.error),
            };
        }
    }

    // OpenCode tool_use format (contains result in state.status)
    if (isToolUseEvent(event)) {
        const part = event.part;
        if (isToolUsePart(part) && part.state) {
            const status = part.state.status;
            const isError = status === 'error' || status === 'failed';
            const result = part.state.result ?? part.state.output ?? part.state.data ?? `Status: ${status}`;
            return {
                toolCallId: String(part.callID || part.callId || part.id || 'unknown'),
                result: typeof result === 'string' ? result : JSON.stringify(result),
                isError,
            };
        }
    }

    const part = event.part;
    if (isToolResultPart(part)) {
        return {
            toolCallId: String(part.toolCallId || part.id || part.tool_call_id || 'unknown'),
            result: resolveResultValue(part),
            isError: !!(part.isError || part.error),
        };
    }

    if (event.result !== undefined && (event.toolCallId || event.id)) {
        return {
            toolCallId: String(event.toolCallId || event.id || 'unknown'),
            result: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
            isError: !!(event.isError || event.error),
        };
    }

    return null;
}

export class OpenCodeFixBackend implements FixBackend {
    readonly name = 'opencode';
    private abortController: AbortController | undefined;

    supportsStreaming(): boolean {
        return true;
    }

    cancel(): void {
        this.abortController?.abort();
    }

    async executeFix(
        diagnostic: SanitizerDiagnostic,
        context: FixContext,
        callbacks?: FixCallbacks,
    ): Promise<FixResult> {
        this.abortController = new AbortController();
        const config = getLLMConfig();
        const workspaceRoot = context.workspaceRoot;
        const resolvedPath = resolveFilePath(diagnostic.fileName, workspaceRoot);

        if (!fs.existsSync(resolvedPath)) {
            return {
                success: false,
                finalMessage: `File not found: ${resolvedPath}`,
                toolCallCount: 0,
                fileChanged: false,
            };
        }

        const originalContent = fs.readFileSync(resolvedPath, 'utf-8');
        const prompt = buildOpenCodePrompt(diagnostic, originalContent);
        const cliPath = config.opencodeCliPath || 'opencode';
        const timeoutMs = config.timeoutMs;

        log(`Executing: ${cliPath} run --format json`);
        log(`Prompt length: ${prompt.length} chars`);
        log(`File: ${resolvedPath}`);

        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        callbacks?.onMessageChunk?.({
            type: 'text_delta',
            delta: `Using OpenCode backend...\n`,
        }, messageId);

        try {
            const result = await this.runOpenCode(cliPath, prompt, timeoutMs, callbacks, messageId);

            if (!result.success) {
                return {
                    success: false,
                    finalMessage: result.error || 'OpenCode execution failed',
                    toolCallCount: 0,
                    fileChanged: false,
                };
            }

            log(`OpenCode response length: ${result.stdout.length}`);
            log(`OpenCode parsed text length: ${result.parsedText.length}`);

            const fixedCode = extractCodeBlock(result.parsedText);

            if (!fixedCode) {
                log('No code block found in response');
                log('Response preview: ' + result.stdout.substring(0, 500));

                callbacks?.onMessageChunk?.({
                    type: 'text_delta',
                    delta: `\n❌ Could not extract fixed code from OpenCode response.\n`,
                }, messageId);

                return {
                    success: false,
                    finalMessage: 'OpenCode did not return a valid code block. The response may not have contained the fixed file content.',
                    toolCallCount: 0,
                    fileChanged: false,
                };
            }

            log(`Extracted code block length: ${fixedCode.length}`);

            const normalizedOriginal = originalContent.replace(/\r\n/g, '\n').trim();
            const normalizedFixed = fixedCode.replace(/\r\n/g, '\n').trim();

            if (normalizedOriginal === normalizedFixed) {
                log('Code did not change');

                callbacks?.onMessageChunk?.({
                    type: 'text_delta',
                    delta: `\n⚠️ OpenCode returned the same code. No changes were made.\n`,
                }, messageId);

                return {
                    success: false,
                    finalMessage: 'OpenCode returned the same code. No changes were made.',
                    toolCallCount: 0,
                    fileChanged: false,
                };
            }

            fs.writeFileSync(resolvedPath, fixedCode, 'utf-8');
            log('Fixed code written to file');

            callbacks?.onDiff?.(resolvedPath, originalContent, fixedCode, 'opencode_fix');

            callbacks?.onMessageChunk?.({
                type: 'text_delta',
                delta: `\n✅ Fix applied successfully. File updated.\n`,
            }, messageId);

            return {
                success: true,
                finalMessage: 'Fix applied successfully using OpenCode.',
                toolCallCount: 1,
                fileChanged: true,
                originalContent,
                newContent: fixedCode,
            };
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            log(`Error: ${errorMsg}`);

            return {
                success: false,
                finalMessage: `OpenCode fix failed: ${errorMsg}`,
                toolCallCount: 0,
                fileChanged: false,
            };
        }
    }

    private async runOpenCode(
        cliPath: string,
        prompt: string,
        timeoutMs: number,
        callbacks?: FixCallbacks,
        messageId?: string,
    ): Promise<{ success: boolean; stdout: string; parsedText: string; error?: string }> {
        return new Promise((resolve) => {
            const child = child_process.spawn(cliPath, ['run', '--format', 'json'], {
                timeout: timeoutMs,
            });

            let stdout = '';
            let parsedText = '';
            let stderr = '';
            const errorMessages: string[] = [];
            const ocToolCallIdMap = new Map<string, string>();
            let lastEventTime = Date.now();
            let hasReceivedAnyEvent = false;

            const INACTIVITY_TIMEOUT_MS = 120000;

            function resetSlidingTimeout(): void {
                lastEventTime = Date.now();
                hasReceivedAnyEvent = true;
            }

            const inactivityTimer = setInterval(() => {
                const elapsed = Date.now() - lastEventTime;
                if (hasReceivedAnyEvent && elapsed > INACTIVITY_TIMEOUT_MS) {
                    clearInterval(inactivityTimer);
                    clearTimeout(hardTimeoutId);
                    child.kill('SIGTERM');
                    resolve({
                        success: false,
                        stdout,
                        parsedText,
                        error: `OpenCode stalled: no events for ${INACTIVITY_TIMEOUT_MS / 1000}s (last event was ${elapsed / 1000}s ago). The model may be unresponsive or OpenCode is stuck.`,
                    });
                }
            }, 10000);

            function showProgress(eventType: string, event: any): void {
                const reason = event?.part?.reason || event?.reason;
                const progressMessages: Record<string, string> = {
                    step_start: '🔄 OpenCode is analyzing the problem...',
                    message_start: '📝 OpenCode is generating response...',
                    message_end: '✅ OpenCode response complete',
                };
                let msg = progressMessages[eventType];
                if (!msg && (eventType === 'step_end' || eventType === 'step_finish')) {
                    if (reason === 'tool-calls') {
                        msg = '🔄 OpenCode is using tools...';
                    } else if (reason) {
                        msg = `✅ OpenCode finished (reason: ${reason})`;
                    } else {
                        msg = '✅ OpenCode finished a step';
                    }
                }
                if (msg) {
                    callbacks?.onMessageChunk?.({
                        type: 'text_delta',
                        delta: `${msg}\n`,
                    }, messageId || `msg_${Date.now()}`);
                }
            }

            function isCompletionEvent(event: any): boolean {
                return event?.type === 'step_end'
                    || event?.type === 'message_end'
                    || event?.type === 'done'
                    || event?.type === 'complete'
                    || event?.type === 'finish';
            }

            if (child.stdout) {
                child.stdout.on('data', (data) => {
                    const text = data.toString();
                    stdout += text;

                    const lines = text.split('\n');
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const event = JSON.parse(line);
                            resetSlidingTimeout();

                            if (event.type === 'text' && event.part?.text) {
                                parsedText += event.part.text;
                                callbacks?.onMessageChunk?.({
                                    type: 'text_delta',
                                    delta: event.part.text,
                                }, messageId || `msg_${Date.now()}`);
                            }

                            if (event.type === 'error' && event.error) {
                                const msg = event.error.data?.message || event.error.message || JSON.stringify(event.error);
                                errorMessages.push(msg);
                                log(`OpenCode error event: ${msg}`);
                                callbacks?.onMessageChunk?.({
                                    type: 'text_delta',
                                    delta: `\n❌ OpenCode error: ${msg}\n`,
                                }, messageId || `msg_${Date.now()}`);
                            }

                            showProgress(event.type, event);

                            if (isCompletionEvent(event)) {
                                log(`OpenCode completion event received: ${event.type}`);
                            }

                            const toolCallInfo = extractToolCall(event);
                            if (toolCallInfo) {
                                const ourToolCallId = `oc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                                if (toolCallInfo.toolCallId) {
                                    ocToolCallIdMap.set(toolCallInfo.toolCallId, ourToolCallId);
                                }
                                callbacks?.onToolCall?.(
                                    toolCallInfo.name,
                                    toolCallInfo.params,
                                    ourToolCallId,
                                );
                            }

                            const toolResultInfo = extractToolResult(event);
                            if (toolResultInfo) {
                                const mappedId = ocToolCallIdMap.get(toolResultInfo.toolCallId);
                                callbacks?.onToolResult?.(
                                    mappedId || toolResultInfo.toolCallId || 'unknown',
                                    toolResultInfo.result,
                                    toolResultInfo.isError,
                                );
                                if (toolResultInfo.isError) {
                                    const toolName = toolCallInfo?.name || 'unknown';
                                    const errorMsg = `Tool ${toolName} failed: ${toolResultInfo.result}`;
                                    errorMessages.push(errorMsg);
                                    log(`Tool error (${toolName}): ${toolResultInfo.result}`);
                                    callbacks?.onMessageChunk?.({
                                        type: 'text_delta',
                                        delta: `\n⚠️ ${errorMsg}\n`,
                                    }, messageId || `msg_${Date.now()}`);
                                }
                            }

                            if (event.type && event.type !== 'text' && event.type !== 'error' && !isCompletionEvent(event) && !toolCallInfo && !toolResultInfo) {
                                log(`OpenCode event: ${event.type} | ${JSON.stringify(event).substring(0, 200)}`);
                            }
                        } catch {
                        }
                    }
                });
            }

            if (child.stderr) {
                child.stderr.on('data', (data) => {
                    const text = data.toString();
                    stderr += text;
                    if (text.trim()) {
                        log(`OpenCode stderr: ${text.trim().substring(0, 200)}`);
                    }
                });
            }

            if (child.stdin) {
                child.stdin.write(prompt);
                child.stdin.end();
            }

            const hardTimeoutId = setTimeout(() => {
                clearInterval(inactivityTimer);
                child.kill('SIGTERM');
                resolve({
                    success: false,
                    stdout,
                    parsedText,
                    error: `OpenCode reached hard timeout after ${timeoutMs / 1000}s. If the model is slow, increase timeoutMs in settings.`,
                });
            }, timeoutMs);

            child.on('close', (exitCode) => {
                clearInterval(inactivityTimer);
                clearTimeout(hardTimeoutId);
                if (errorMessages.length > 0) {
                    resolve({
                        success: false,
                        stdout,
                        parsedText,
                        error: `OpenCode error: ${errorMessages.join('; ')}`,
                    });
                    return;
                }
                if (exitCode !== 0 && !stdout) {
                    resolve({
                        success: false,
                        stdout,
                        parsedText,
                        error: `OpenCode CLI exited with code ${exitCode}. Stderr: ${stderr}`,
                    });
                    return;
                }
                resolve({ success: true, stdout, parsedText });
            });

            child.on('error', (err) => {
                clearInterval(inactivityTimer);
                clearTimeout(hardTimeoutId);
                if (err.message?.includes('ENOENT')) {
                    resolve({
                        success: false,
                        stdout,
                        parsedText,
                        error: `OpenCode CLI not found at: ${cliPath}. Please install OpenCode or set correct path in settings.`,
                    });
                } else {
                    resolve({
                        success: false,
                        stdout,
                        parsedText,
                        error: `Failed to run OpenCode: ${err.message}`,
                    });
                }
            });

            this.abortController?.signal.addEventListener('abort', () => {
                clearInterval(inactivityTimer);
                clearTimeout(hardTimeoutId);
                child.kill('SIGTERM');
                resolve({
                    success: false,
                    stdout,
                    parsedText,
                    error: 'Fix cancelled by user',
                });
            });
        });
    }
}
