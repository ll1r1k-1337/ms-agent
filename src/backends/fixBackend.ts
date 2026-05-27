import { StreamChunk } from '../llm/types';
import type { RepairIssue } from '../vscode/repairIssue';

export interface FixCallbacks {
    onMessageChunk?: (chunk: StreamChunk, messageId: string) => void;
    onToolCall?: (name: string, params: Record<string, unknown>, toolCallId: string) => void;
    onToolResult?: (toolCallId: string, result: string, isError: boolean) => void;
    onDiff?: (filePath: string, oldText: string, newText: string, toolCallId: string) => void;
    onTextResponse?: (text: string) => void;
    // NEW for PR-C: generic event callback for extensibility
    onEvent?: (type: string, payload: unknown) => void;
}

export interface FixContext {
    workspaceRoot: string;
    extensionContext?: import('vscode').ExtensionContext;
}

export type FixOutcome = 'applied' | 'no_change' | 'failed';
export type ExplanationKind = 'structured' | 'synthetic' | 'plain' | 'missing';

export interface FixResult {
    success: boolean;
    outcome: FixOutcome;
    finalMessage: string;
    explanationKind?: ExplanationKind;
    toolCallCount: number;
    fileChanged: boolean;
    originalContent?: string;
    newContent?: string;
}

export interface FixBackend {
    readonly name: string;

    /**
     * Execute a fix for the given diagnostic.
     * @param diagnostic The repair issue to fix
     * @param context Fix context (workspace root, extension context)
     * @param callbacks Optional callbacks for streaming UI updates
     * @returns Fix result
     */
    executeFix(
        diagnostic: RepairIssue,
        context: FixContext,
        callbacks?: FixCallbacks,
    ): Promise<FixResult>;

    /**
     * Check if this backend supports streaming progress updates.
     */
    supportsStreaming(): boolean;

    /**
     * Cancel an in-progress fix operation.
     */
    cancel(): void;
}
