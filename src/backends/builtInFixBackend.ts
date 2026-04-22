import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { FixBackend, FixCallbacks, FixContext, FixResult } from './fixBackend';
import { SanitizerDiagnostic } from '../parser/types';
import { runAgent } from '../agent/agentLoop';
import { OpenAICompatProvider } from '../llm/openaiCompatProvider';
import { getToolDefinitions, executeTool, ToolContext } from '../tools/toolHandlers';
import { loadSkill, buildFixPrompt } from '../skills/skillLoader';
import { StreamChunk } from '../llm/types';
import { getLLMConfig } from '../llm/config';

function resolveFilePath(fileName: string, workspaceRoot: string): string {
    if (path.isAbsolute(fileName) && fs.existsSync(fileName)) {
        return fileName;
    }
    return path.resolve(workspaceRoot, fileName);
}

export class BuiltInFixBackend implements FixBackend {
    readonly name = 'builtin';
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

        const llm = new OpenAICompatProvider({
            endpoint: config.endpoint,
            modelName: config.modelName,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            timeoutMs: config.timeoutMs,
            apiKey: config.apiKey,
        });

        const skillContent = loadSkill('memcheck-skills') || '';
        let prompt = buildFixPrompt(diagnostic);
        if (skillContent) {
            prompt += '\n\n## Additional Context\n' + skillContent;
        }

        const toolContext: ToolContext = {
            workspaceRoot,
            diagnostics: diagnostic,
        };

        const resolvedPath = resolveFilePath(diagnostic.fileName, workspaceRoot);
        const originalContent = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf-8') : '';

        const abortSignal = this.abortController?.signal;
        try {
            const agentResult = await runAgent({
                systemPrompt: 'You are a memory error fix specialist for Ascend NPU operators. Read the source file, understand the error, and apply a minimal fix. Use the edit_file tool to make changes.',
                taskDescription: prompt,
                toolContext,
                llm,
                maxToolRounds: 10,
                abortSignal: { get aborted() { return abortSignal?.aborted ?? false; } },
                useStreaming: true,

                onMessageChunk: (chunk: StreamChunk, messageId: string) => {
                    if (this.abortController?.signal.aborted) return;
                    callbacks?.onMessageChunk?.(chunk, messageId);
                },

                onToolCall: (name, params, toolCallId) => {
                    if (this.abortController?.signal.aborted) return;
                    callbacks?.onToolCall?.(name, params, toolCallId);
                },

                onToolResult: (toolCallId, result, isError) => {
                    if (this.abortController?.signal.aborted) return;
                    callbacks?.onToolResult?.(toolCallId, result, isError);
                },

                onDiff: (filePath, oldText, newText, toolCallId) => {
                    if (this.abortController?.signal.aborted) return;
                    callbacks?.onDiff?.(filePath, oldText, newText, toolCallId);
                },
            });

            let newContent = '';
            let fileChanged = false;
            if (fs.existsSync(resolvedPath)) {
                newContent = fs.readFileSync(resolvedPath, 'utf-8');
                fileChanged = originalContent !== newContent;
            }

            return {
                success: true,
                finalMessage: agentResult.finalMessage,
                toolCallCount: agentResult.toolCallCount,
                fileChanged,
                originalContent,
                newContent,
            };
        } catch (e) {
            throw e;
        }
    }
}
