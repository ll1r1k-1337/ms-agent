import * as fs from 'fs';
import { ExplanationKind, FixOutcome, FixResult } from './fixBackend';
import { OpenCodeTransport } from './opencodeTransport';
import { StreamChunk } from '../llm/types';
import { MemErrorType, SanitizerDiagnostic } from '../parser/types';
import {
    extractToolCall,
    extractToolResult,
    extractTextDelta,
    extractErrorMessage,
    extractSessionId,
    isCompletionEvent,
    extractAssistantFinishReason,
    extractMessageId,
    extractMessageRole,
    extractPartMessageId,
    isToolCallContinuationBoundary,
    ToolCallInfo,
    ToolResultInfo,
    OpenCodeEvent,
} from './opencodeEventAdapter';
import { SessionStateMachine } from '../agent/sessionStateMachine';
import { DisposableStore } from '../agent/disposableStore';

type ToolKind = 'read' | 'edit' | 'other';

const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
    'edit_file',
    'apply_patch',
    'write_file',
    'write',
    'patch',
]);

const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
    'read',
    'read_file',
    'glob',
    'grep',
    'list',
    'list_files',
]);

function getOutputChannel(): { appendLine: (msg: string) => void } {
    const globalAny = global as any;
    if (globalAny.msAgentOutputChannel) {
        return globalAny.msAgentOutputChannel;
    }
    return { appendLine: (msg: string) => console.log(msg) };
}

function logSession(message: string): void {
    getOutputChannel().appendLine(`[OpenCodeSession] ${message}`);
}

function classifyToolKind(name: string): ToolKind {
    const normalized = name.trim().toLowerCase();
    if (EDIT_TOOL_NAMES.has(normalized)) {
        return 'edit';
    }
    if (READ_ONLY_TOOL_NAMES.has(normalized)) {
        return 'read';
    }
    return 'other';
}

// Guard against models that echo the prompt's example placeholder or emit a
// truncated summary instead of the full file. Writing such a response would
// destroy the original file. When this returns a non-empty reason, the caller
// MUST NOT overwrite the target file.
export function detectPlaceholderResponse(
    fixedCode: string,
    _originalContent: string,
): string {
    const trimmed = fixedCode.trim();
    if (trimmed.length === 0) {
        return 'Extracted code block is empty';
    }

    const lower = trimmed.toLowerCase();
    const placeholderPhrases = [
        'complete fixed file content',
        'fixed file content',
        'entire file content',
        'rest of file unchanged',
        'rest of the file',
        'file content here',
    ];
    for (const phrase of placeholderPhrases) {
        if (lower.includes(phrase)) {
            return `Response contains placeholder phrase "${phrase}"`;
        }
    }

    const nonEmptyLines = trimmed.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const ellipsisOnlyPattern = /^(?:\/\/|\/\*|\*|#|<!--)\s*\.{2,}.*$/;
    const isAllEllipsisComments =
        nonEmptyLines.length > 0 && nonEmptyLines.every((l) => ellipsisOnlyPattern.test(l));
    if (isAllEllipsisComments) {
        return 'Response contains only ellipsis placeholder comments';
    }

    // Detect focused-snippet echo: lines that look like the prompt's focused
    // snippet (e.g. "    25 | " or ">   30 | ") are not actual code.
    const snippetLinePattern = /^[ >]\s*\d+\s+\| /m;
    if (snippetLinePattern.test(trimmed)) {
        return 'Response contains focused snippet line markers instead of actual code';
    }

    // The 20% length heuristic was removed because a valid fix can be a
    // one-line change in a large file (e.g. a diff or patch). Length alone
    // is not a reliable indicator of truncation. We now rely on structural
    // completeness checks and placeholder detection instead.
    const hasCodeBlocks = trimmed.includes('```');
    const diffLikeLines = trimmed.split('\n').filter((l) =>
        /^\s*(?:[+\-@]|diff\s|index\s)/.test(l),
    );
    const looksLikeDiff = diffLikeLines.length >= 2;
    if (hasCodeBlocks || looksLikeDiff) {
        return '';
    }

    return '';
}

export interface OpenCodeSessionCallbacks {
    onMessageChunk?: (chunk: StreamChunk, messageId: string) => void;
    onToolCall?: (name: string, params: Record<string, unknown>, toolCallId: string) => void;
    onToolResult?: (toolCallId: string, result: string, isError: boolean) => void;
    onDiff?: (filePath: string, oldText: string, newText: string, toolCallId: string) => void;
    onEvent?: (type: string, payload: unknown) => void;
}

interface AssistantExplanation {
    text: string;
    kind: ExplanationKind;
}

interface RunDiagnosticContext {
    errorType: MemErrorType;
    fileName: string;
    lineNumber: number;
    addressSpace: string;
    byteSize: number;
}

function hasStructuredExplanation(text: string): boolean {
    return /^(Problem|Fix|Why it works|Notes)\s*:/im.test(text);
}

function looksLikeProcessNarration(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return [
        /^i[' ]?ll\b/,
        /^i will\b/,
        /^let me\b/,
        /^verifying\b/,
        /^checking\b/,
        /^inspecting\b/,
        /^reviewing\b/,
        /^reading\b/,
        /^first\b/,
        /^next\b/,
        /^need to\b/,
        /^going to\b/,
    ].some((pattern) => pattern.test(normalized));
}

function classifyAssistantExplanation(text: string): AssistantExplanation | null {
    const trimmed = text.trim();
    if (!trimmed) {
        return null;
    }
    if (hasStructuredExplanation(trimmed)) {
        return { text: trimmed, kind: 'structured' };
    }
    // Drop only short, single-sentence pre-tool narration ("I'll check the
    // file", "Let me read it"). Longer text that opens with such phrasing
    // typically carries real content (root cause, change rationale) and is
    // strictly more useful than the canned "Explanation unavailable" notice.
    if (looksLikeProcessNarration(trimmed) && isShortSingleSentence(trimmed)) {
        return null;
    }
    return { text: trimmed, kind: 'plain' };
}

function isShortSingleSentence(text: string): boolean {
    if (text.length > 160) return false;
    const sentenceBreaks = (text.match(/[.!?。！？]\s+\S/g) || []).length;
    return sentenceBreaks <= 1 && !/\n\s*\n/.test(text);
}

function extractAssistantExplanationFromTextMap(
    messageTexts: Map<string, string>,
    messageOrder: string[],
    preferredMessageId?: string | null,
): AssistantExplanation | null {
    const orderedIds: string[] = [];
    if (preferredMessageId) {
        orderedIds.push(preferredMessageId);
    }
    for (let i = messageOrder.length - 1; i >= 0; i -= 1) {
        const currentId = messageOrder[i];
        if (!orderedIds.includes(currentId)) {
            orderedIds.push(currentId);
        }
    }
    for (const id of orderedIds) {
        const explanation = classifyAssistantExplanation(String(messageTexts.get(id) || ''));
        if (explanation) {
            return explanation;
        }
    }
    return null;
}

function extractMessageSnapshotRole(message: unknown): string | null {
    if (!message || typeof message !== 'object') {
        return null;
    }
    const record = message as Record<string, unknown>;
    if (typeof record.role === 'string') {
        return record.role;
    }
    if (record.info && typeof record.info === 'object' && record.info !== null) {
        const info = record.info as Record<string, unknown>;
        return typeof info.role === 'string' ? info.role : null;
    }
    return null;
}

function extractMessageSnapshotId(message: unknown): string | null {
    if (!message || typeof message !== 'object') {
        return null;
    }
    const record = message as Record<string, unknown>;
    if (typeof record.id === 'string') {
        return record.id;
    }
    if (typeof record.messageID === 'string') {
        return record.messageID;
    }
    if (typeof record.messageId === 'string') {
        return record.messageId;
    }
    if (record.info && typeof record.info === 'object' && record.info !== null) {
        const info = record.info as Record<string, unknown>;
        return typeof info.id === 'string' ? info.id : null;
    }
    return null;
}

function extractMessageSnapshotText(message: unknown): string {
    if (!message || typeof message !== 'object') {
        return '';
    }
    const record = message as Record<string, unknown>;
    const info = record.info && typeof record.info === 'object' ? record.info as Record<string, unknown> : null;
    const parts = Array.isArray(record.parts)
        ? record.parts
        : Array.isArray(info?.parts)
            ? info.parts as unknown[]
            : [];
    const collected: string[] = [];
    for (const part of parts) {
        if (!part || typeof part !== 'object') {
            continue;
        }
        const partRecord = part as Record<string, unknown>;
        const partType = typeof partRecord.type === 'string' ? partRecord.type : '';
        if (partType && partType !== 'text') {
            continue;
        }
        const candidateFields = [
            partRecord.text,
            partRecord.content,
            partRecord.delta,
            partRecord.output,
            partRecord.message,
        ];
        for (const candidate of candidateFields) {
            if (typeof candidate === 'string' && candidate.trim()) {
                collected.push(candidate);
                break;
            }
        }
    }
    if (collected.length > 0) {
        return collected.join('\n').trim();
    }
    const topLevelText = [record.text, record.content, record.message].find(
        (value) => typeof value === 'string' && value.trim().length > 0,
    );
    return typeof topLevelText === 'string' ? topLevelText.trim() : '';
}

function extractAssistantExplanationFromSessionMessages(
    messages: unknown[] | null,
    preferredMessageId?: string | null,
): AssistantExplanation | null {
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }
    const assistantMessages = messages.filter((message) => extractMessageSnapshotRole(message) === 'assistant');
    if (assistantMessages.length === 0) {
        return null;
    }
    const orderedMessages: unknown[] = [];
    if (preferredMessageId) {
        const preferred = assistantMessages.find(
            (message) => extractMessageSnapshotId(message) === preferredMessageId,
        );
        if (preferred) {
            orderedMessages.push(preferred);
        }
    }
    for (let i = assistantMessages.length - 1; i >= 0; i -= 1) {
        const message = assistantMessages[i];
        if (!orderedMessages.includes(message)) {
            orderedMessages.push(message);
        }
    }
    for (const message of orderedMessages) {
        const explanation = classifyAssistantExplanation(extractMessageSnapshotText(message));
        if (explanation) {
            return explanation;
        }
    }
    return null;
}

function missingExplanation(): AssistantExplanation {
    return {
        kind: 'missing',
        text: 'OpenCode applied the fix but did not return an explanation in this session.',
    };
}

function formatStructuredExplanation(problem: string, fix: string, why: string): string {
    return `Problem: ${problem}\nFix: ${fix}\nWhy it works: ${why}`;
}

function normalizeInlineCode(line: string): string {
    const trimmed = line.trim();
    return trimmed ? `\`${trimmed}\`` : '`the reported line`';
}

function getLineAt(content: string, lineNumber: number): string {
    const lines = content.split(/\r?\n/);
    const index = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
    return lines[index] || '';
}

function getChangedLines(originalContent: string, newContent: string): Array<{ lineNumber: number; before: string; after: string }> {
    const originalLines = originalContent.replace(/\r\n/g, '\n').split('\n');
    const newLines = newContent.replace(/\r\n/g, '\n').split('\n');
    const maxLines = Math.max(originalLines.length, newLines.length);
    const changed: Array<{ lineNumber: number; before: string; after: string }> = [];
    for (let index = 0; index < maxLines; index += 1) {
        const before = originalLines[index] ?? '';
        const after = newLines[index] ?? '';
        if (before !== after) {
            changed.push({ lineNumber: index + 1, before, after });
        }
    }
    return changed;
}

function describeProblem(diagnostic?: RunDiagnosticContext | SanitizerDiagnostic, changedLine?: string): string {
    if (!diagnostic) {
        return 'the reported memory-safety issue required a code change at the flagged location.';
    }
    switch (diagnostic.errorType) {
        case MemErrorType.OUT_OF_BOUNDS:
            if (/\bDataCopy\s*\(/.test(changedLine || '')) {
                return 'the DataCopy operation at the reported line could write past the destination buffer bounds.';
            }
            return 'the reported memory access could go out of bounds at the flagged line.';
        case MemErrorType.ILLEGAL_ADDR_WRITE:
            return 'the reported write could target an invalid address range.';
        case MemErrorType.ILLEGAL_ADDR_READ:
            return 'the reported read could access an invalid address range.';
        case MemErrorType.MISALIGNED_ACCESS:
            return 'the reported memory access used an invalid alignment for the target buffer.';
        case MemErrorType.UNINITIALIZED_READ:
            return 'the reported read could consume data before it was initialized.';
        case MemErrorType.MEM_LEAK:
            return 'the reported allocation path did not release memory correctly.';
        case MemErrorType.ILLEGAL_FREE:
            return 'the reported free operation could release an invalid or already-freed allocation.';
        case MemErrorType.MEM_UNUSED:
            return 'the reported allocation path kept memory that was not used correctly.';
        default:
            return `the reported ${diagnostic.errorType} issue required a targeted code change.`;
    }
}

function describeWhyItWorks(diagnostic?: RunDiagnosticContext | SanitizerDiagnostic, beforeLine?: string, afterLine?: string): string {
    if (diagnostic?.errorType === MemErrorType.OUT_OF_BOUNDS && /\bDataCopy\s*\(/.test(beforeLine || '') && /\bDataCopy\s*\(/.test(afterLine || '')) {
        return 'the updated copy length now matches the destination buffer capacity, so the write stays within bounds.';
    }
    if (diagnostic?.errorType === MemErrorType.UNINITIALIZED_READ) {
        return 'the updated code ensures the value is initialized before it is consumed on the flagged path.';
    }
    if (diagnostic?.errorType === MemErrorType.MISALIGNED_ACCESS) {
        return 'the updated access now uses a buffer or offset that satisfies the required alignment.';
    }
    if (diagnostic?.errorType === MemErrorType.ILLEGAL_ADDR_READ || diagnostic?.errorType === MemErrorType.ILLEGAL_ADDR_WRITE) {
        return 'the updated code narrows the memory access to a valid address range for the reported operation.';
    }
    return 'the applied change adjusts the implementation at the reported location so the flagged memory-safety condition is no longer triggered on that path.';
}

function buildSyntheticExplanation(
    originalContent: string,
    newContent: string,
    diagnostic?: RunDiagnosticContext | SanitizerDiagnostic,
): AssistantExplanation {
    const changedLines = getChangedLines(originalContent, newContent);
    const targetLineNumber = diagnostic?.lineNumber;
    const targetChange = changedLines.find((entry) => entry.lineNumber === targetLineNumber) || changedLines[0];
    const beforeLine = targetChange?.before ?? (targetLineNumber ? getLineAt(originalContent, targetLineNumber) : '');
    const afterLine = targetChange?.after ?? (targetLineNumber ? getLineAt(newContent, targetLineNumber) : '');
    const problem = describeProblem(diagnostic, beforeLine);
    const fix = targetChange
        ? `changed ${normalizeInlineCode(beforeLine)} to ${normalizeInlineCode(afterLine)}.`
        : diagnostic
            ? `updated ${normalizeInlineCode(diagnostic.fileName + ':' + diagnostic.lineNumber)} to address the reported ${diagnostic.errorType} issue.`
            : 'applied a targeted code change to the reported location.';
    const why = describeWhyItWorks(diagnostic, beforeLine, afterLine);
    return {
        kind: 'synthetic',
        text: formatStructuredExplanation(problem, fix, why),
    };
}

function isIgnorablePostApplyError(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return normalized === 'aborted'
        || normalized.includes('messageabortederror')
        || normalized.includes('aborted');
}

function extractTerminalReason(
    parsedText: string,
    marker: 'NO_FIX_NEEDED' | 'CANNOT_FIX',
): string | null {
    const regex = new RegExp(`${marker}:\\s*(.+)`, 'i');
    const match = parsedText.match(regex);
    if (!match) {
        return null;
    }
    const reason = match[1].trim();
    return reason.length > 0 ? reason : null;
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
        diagnostic?: RunDiagnosticContext | SanitizerDiagnostic;
        timeoutMs: number;
        messageId?: string;
        mode?: string;
        model?: string;
    }): Promise<FixResult> {
        if (this.cancelled) {
            return {
                success: false,
                outcome: 'failed',
                finalMessage: 'Fix cancelled by user',
                toolCallCount: 0,
                fileChanged: false,
            };
        }

        const messageId = options.messageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        this.callbacks?.onEvent?.('session_start', {
            backend: 'opencode',
            mode: options.mode || 'server',
            model: options.model,
        });

        return new Promise<FixResult>((resolve, reject) => {
            let parsedText = '';
            const messageTexts = new Map<string, string>();
            const assistantMessageOrder: string[] = [];
            const errorMessages: string[] = [];
            const seenErrorMessages = new Set<string>();
            const assistantMessageIds = new Set<string>();
            let completedAssistantMessageId: string | null = null;
            const seenToolCallIds = new Set<string>();
            let toolCallCount = 0;
            let finalized = false;
            let transportError: Error | null = null;
            let opencodeSessionId: string | undefined;
            let seenReadOnlyToolCall = false;
            let seenEditToolCall = false;
            let seenEditToolResult = false;
            let lastAssistantFinishReason: string | null = null;
            let waitingForToolContinuation = false;
            const toolKindsById = new Map<string, ToolKind>();
            const normalizedOriginalContent = options.originalContent.replace(/\r\n/g, '\n').trim();

            // Single source of truth: SessionStateMachine. All lifecycle
            // signals (events, transport close, abort, timeout, errors) are
            // dispatched into the SM. The SM's state is then read by code
            // paths that previously relied on parallel boolean flags.
            // DisposableStore unifies cleanup of timer, SM subscription, and
            // abort-signal listener so resource release is single-step.
            const sm = new SessionStateMachine();
            const store = new DisposableStore();

            const recordErrorMessage = (message: string): boolean => {
                const normalized = message.trim();
                if (!normalized || seenErrorMessages.has(normalized)) {
                    return false;
                }
                seenErrorMessages.add(normalized);
                errorMessages.push(normalized);
                return true;
            };

            const ensureAssistantMessageOrder = (id: string): void => {
                if (!assistantMessageOrder.includes(id)) {
                    assistantMessageOrder.push(id);
                }
            };

            // Derived: a HARD protocol terminal was seen iff the SM ever
            // transitioned into 'applying_patch' (the only entry path is via
            // a TERMINAL_EVENT dispatch from streaming/awaiting_tool). This
            // flag is set inside the SM observer below; never written
            // anywhere else, so SM state remains the single source of truth.
            let observedHardTerminal = false;
            const sawHardTerminal = (): boolean => observedHardTerminal;

            const hasDiskChanged = (): boolean => {
                try {
                    const current = fs.readFileSync(options.resolvedPath, 'utf-8');
                    return current.replace(/\r\n/g, '\n').trim() !== normalizedOriginalContent;
                } catch {
                    return false;
                }
            };

            const unsubscribeSm = sm.subscribe((snap) => {
                if (snap.state === 'applying_patch') {
                    observedHardTerminal = true;
                }
                this.callbacks?.onEvent?.('lifecycle_state', {
                    state: snap.state,
                    previous: snap.previous,
                });
            });
            store.add(unsubscribeSm);
            sm.dispatch({ kind: 'START', detail: options.mode });

            const doResolve = (result: FixResult): void => {
                if (finalized) {
                    return;
                }
                finalized = true;
                // Drive SM through its terminal sequence so observers see the
                // final state. Best-effort: SM may already be in a terminal
                // state via earlier dispatch (e.g. PROTOCOL_ERROR), in which
                // case ENTER_TERMINAL is the only valid next step.
                if (!sm.isTerminal() && sm.state() !== 'cleanup') {
                    if (result.success) {
                        sm.dispatch({
                            kind: 'PATCH_APPLIED',
                            result: {
                                success: result.success,
                                fileChanged: result.fileChanged,
                                finalMessage: result.finalMessage,
                                toolCallCount: result.toolCallCount,
                                originalContent: result.originalContent,
                                newContent: result.newContent,
                            },
                        });
                    }
                }
                sm.dispatch({ kind: 'ENTER_TERMINAL' });
                sm.dispatch({ kind: 'DISPOSED' });
                store.dispose();
                resolve(result);
            };

            const finalize = async (): Promise<void> => {
                if (finalized) {
                    return;
                }
                const emitSessionEnd = (
                    outcome: FixOutcome,
                    finalMessage: string,
                    explanationKind?: ExplanationKind,
                ): void => {
                    this.callbacks?.onEvent?.('session_end', {
                        success: outcome === 'applied',
                        outcome,
                        finalMessage,
                        explanationKind,
                    });
                };

                if (this.cancelled || this.abortController.signal.aborted) {
                    emitSessionEnd('failed', 'Fix cancelled by user');
                    doResolve({
                        success: false,
                        outcome: 'failed',
                        finalMessage: 'Fix cancelled by user',
                        toolCallCount,
                        fileChanged: false,
                    });
                    return;
                }

                if (transportError) {
                    emitSessionEnd('failed', `Transport error: ${transportError.message}`);
                    doResolve({
                        success: false,
                        outcome: 'failed',
                        finalMessage: `Transport error: ${transportError.message}`,
                        toolCallCount,
                        fileChanged: false,
                    });
                    return;
                }

                if (!sawHardTerminal()) {
                    const msg =
                        'Transport closed before hard terminal event; original file preserved (protocol incomplete).';
                    sm.dispatch({
                        kind: 'PROTOCOL_ERROR',
                        reason: 'Transport closed before terminal event',
                    });
                    emitSessionEnd('failed', msg);
                    doResolve({
                        success: false,
                        outcome: 'failed',
                        finalMessage: msg,
                        toolCallCount,
                        fileChanged: false,
                    });
                    return;
                }

                // Give OpenCode a brief grace window to flush native file edits
                // before we compare the on-disk content.
                await new Promise((resolve) => setTimeout(resolve, 150));

                let diskContent: string | null = null;
                try {
                    diskContent = fs.readFileSync(options.resolvedPath, 'utf-8');
                } catch (err) {
                }
                const normalizedDisk = diskContent === null
                    ? null
                    : diskContent.replace(/\r\n/g, '\n').trim();
                const diskChanged = normalizedDisk !== null && normalizedDisk !== normalizedOriginalContent;
                logSession(
                    `finalize_check diskChanged=${diskChanged} hardTerminal=${sawHardTerminal()} finish=${lastAssistantFinishReason || 'none'} errors=${errorMessages.length}`,
                );

                if (diskContent !== null) {
                    if (diskChanged) {
                        const hasFatalError = errorMessages.some((message) => !isIgnorablePostApplyError(message));
                        if (hasFatalError) {
                            emitSessionEnd('failed', errorMessages.join('; '));
                            doResolve({
                                success: false,
                                outcome: 'failed',
                                finalMessage: errorMessages.join('; '),
                                toolCallCount,
                                fileChanged: false,
                            });
                            return;
                        }
                        const streamExplanation = extractAssistantExplanationFromTextMap(
                            messageTexts,
                            assistantMessageOrder,
                            completedAssistantMessageId,
                        );
                        const sessionMessages = streamExplanation
                            ? null
                            : await this.transport.readSessionMessages();
                        const assistantExplanation =
                            (() => {
                                const sessionExplanation = extractAssistantExplanationFromSessionMessages(
                                    sessionMessages,
                                    completedAssistantMessageId,
                                );
                                if (streamExplanation?.kind === 'structured') {
                                    return streamExplanation;
                                }
                                if (sessionExplanation?.kind === 'structured') {
                                    return sessionExplanation;
                                }
                                return buildSyntheticExplanation(
                                    options.originalContent,
                                    diskContent,
                                    options.diagnostic,
                                );
                            })();
                        this.callbacks?.onDiff?.(options.resolvedPath, options.originalContent, diskContent, 'opencode_edit');
                        emitSessionEnd(
                            'applied',
                            assistantExplanation.text,
                            assistantExplanation.kind,
                        );
                        doResolve({
                            success: true,
                            outcome: 'applied',
                            finalMessage: assistantExplanation.text,
                            explanationKind: assistantExplanation.kind,
                            toolCallCount,
                            fileChanged: true,
                            originalContent: options.originalContent,
                            newContent: diskContent,
                        });
                        return;
                    }
                }

                if (errorMessages.length > 0) {
                    emitSessionEnd('failed', errorMessages.join('; '));
                    doResolve({
                        success: false,
                        outcome: 'failed',
                        finalMessage: errorMessages.join('; '),
                        toolCallCount,
                        fileChanged: false,
                    });
                    return;
                }

                // Find ALL code blocks and use the LAST one (models typically put final answer last)
                const codeBlockRegex = /```(?:cpp|c\+\+|c)\s*\n([\s\S]*?)```/g;
                let lastMatch: RegExpExecArray | null = null;
                let match: RegExpExecArray | null;
                while ((match = codeBlockRegex.exec(parsedText)) !== null) {
                    lastMatch = match;
                }

                if (lastMatch) {
                    const fixedCode = lastMatch[1].trim();
                    const normalizedFixed = fixedCode.replace(/\r\n/g, '\n').trim();

                    if (normalizedOriginalContent !== normalizedFixed) {
                        // Preservation invariant: never overwrite the file from a
                        // code block when no hard protocol terminal was observed.
                        // The wire may have closed mid-stream; the candidate patch
                        // is not trustworthy. The placeholder/size guards below
                        // catch obvious cases, but a syntactically-complete
                        // suspect block would slip through without this check.
                        if (!sawHardTerminal()) {
                            const msg =
                                'Transport closed before hard terminal event; original file preserved (protocol incomplete).';
                            sm.dispatch({
                                kind: 'PROTOCOL_ERROR',
                                reason: 'Transport closed before terminal event',
                            });
                            emitSessionEnd('failed', msg);
                            doResolve({
                                success: false,
                                outcome: 'failed',
                                finalMessage: msg,
                                toolCallCount,
                                fileChanged: false,
                            });
                            return;
                        }

                        const placeholderReason = detectPlaceholderResponse(fixedCode, options.originalContent);
                        const msg = placeholderReason
                            ? `Model returned a placeholder or truncated response; original file preserved (${placeholderReason}).`
                            : 'OpenCode returned a C/C++ code block instead of applying an edit tool; original file preserved to avoid replacing the whole file with partial model output.';
                        logSession('rejected_code_block reason=no-native-edit');
                        emitSessionEnd('failed', msg);
                        doResolve({
                            success: false,
                            outcome: 'failed',
                            finalMessage: msg,
                            toolCallCount,
                            fileChanged: false,
                        });
                        return;
                    }
                }

                // Even when no C++ code block was found, the model may have
                // returned a placeholder or echoed the focused snippet.
                if (!lastMatch) {
                    const placeholderReason = detectPlaceholderResponse(parsedText, options.originalContent);
                    if (placeholderReason) {
                        const msg = `Model returned a placeholder or truncated response; original file preserved (${placeholderReason}).`;
                        emitSessionEnd('failed', msg);
                        doResolve({
                            success: false,
                            outcome: 'failed',
                            finalMessage: msg,
                            toolCallCount,
                            fileChanged: false,
                        });
                        return;
                    }
                }

                const noFixNeededReason = extractTerminalReason(parsedText, 'NO_FIX_NEEDED');
                if (noFixNeededReason) {
                    emitSessionEnd('no_change', noFixNeededReason);
                    doResolve({
                        success: false,
                        outcome: 'no_change',
                        finalMessage: noFixNeededReason,
                        toolCallCount,
                        fileChanged: false,
                    });
                    return;
                }

                const cannotFixReason = extractTerminalReason(parsedText, 'CANNOT_FIX');
                if (cannotFixReason) {
                    emitSessionEnd('failed', cannotFixReason);
                    doResolve({
                        success: false,
                        outcome: 'failed',
                        finalMessage: cannotFixReason,
                        toolCallCount,
                        fileChanged: false,
                    });
                    return;
                }

                const noChangeMsg = lastMatch
                    ? 'OpenCode finished without a native edit; original file preserved for safety because it returned the original code without explaining why.'
                    : 'OpenCode finished without a native edit; original file preserved for safety because it did not provide a parseable reason.';
                emitSessionEnd('failed', noChangeMsg);
                doResolve({
                    success: false,
                    outcome: 'failed',
                    finalMessage: noChangeMsg,
                    toolCallCount,
                    fileChanged: false,
                });
            };

            const timeoutId = setTimeout(() => {
                transportError = new Error(`Fix timed out after ${options.timeoutMs}ms`);
                sm.dispatch({ kind: 'TIMEOUT_INACTIVE', afterMs: options.timeoutMs });
                this.transport.cancel();
                void finalize();
            }, options.timeoutMs);
            store.addTimer(timeoutId);

            // Abort listener registers via DisposableStore so the listener is
            // explicitly removed during cleanup, preventing stale callback
            // delivery (e.g. when a later cancel fires after this run resolved).
            const onAbort = (): void => {
                sm.dispatch({ kind: 'USER_CANCEL' });
                if (!finalized) {
                    void finalize();
                }
            };
            this.abortController.signal.addEventListener('abort', onAbort);
            store.add(() => {
                this.abortController.signal.removeEventListener('abort', onAbort);
            });

            this.transport.onEvent((event: unknown) => {
                if (finalized) {
                    return;
                }

                const e = event as OpenCodeEvent;
                if (e.type === 'session_start') {
                    const sessionId = extractSessionId(e);
                    if (sessionId) {
                        opencodeSessionId = sessionId;
                        this.callbacks?.onEvent?.('session_metadata', { opencodeSessionId: sessionId });
                        logSession(`session=${sessionId} model=${options.model || 'default'} started`);
                    }
                }

                const messageRole = extractMessageRole(e);
                const eventMessageId = extractMessageId(e);
                if (messageRole === 'assistant' && eventMessageId) {
                    assistantMessageIds.add(eventMessageId);
                }
                const partMessageId = extractPartMessageId(e);
                const isAssistantScopedPart = partMessageId
                    ? assistantMessageIds.has(partMessageId)
                    : true;
                const assistantTextMessageId = partMessageId || eventMessageId || messageId;

                const textDelta = extractTextDelta(e);
                if (textDelta && isAssistantScopedPart) {
                    if (waitingForToolContinuation) {
                        waitingForToolContinuation = false;
                    }
                    // Promote SM from sending -> streaming on first meaningful chunk.
                    // The SM ignores TEXT_DELTA in states that don't accept it.
                    sm.dispatch({ kind: 'TEXT_DELTA', chunk: textDelta });
                    if (e.type !== 'reasoning') {
                        const prev = messageTexts.get(assistantTextMessageId) || '';
                        ensureAssistantMessageOrder(assistantTextMessageId);
                        if (textDelta.startsWith(prev) && textDelta.length > prev.length) {
                            const delta = textDelta.substring(prev.length);
                            messageTexts.set(assistantTextMessageId, textDelta);
                            parsedText += delta;
                            this.callbacks?.onMessageChunk?.({ type: 'text_delta', delta }, assistantTextMessageId);
                        } else if (textDelta !== prev) {
                            messageTexts.set(assistantTextMessageId, prev + textDelta);
                            parsedText += textDelta;
                            this.callbacks?.onMessageChunk?.({ type: 'text_delta', delta: textDelta }, assistantTextMessageId);
                        }
                    } else {
                        this.callbacks?.onMessageChunk?.({ type: 'text_delta', delta: textDelta }, assistantTextMessageId + '_reasoning');
                    }
                } else {
                }

                const errorMsg = extractErrorMessage(e);
                if (errorMsg) {
                    if (recordErrorMessage(errorMsg)) {
                        this.callbacks?.onMessageChunk?.(
                            { type: 'text_delta', delta: `\n❌ OpenCode error: ${errorMsg}\n` },
                            messageId,
                        );
                    }
                }

                const toolCallInfo: ToolCallInfo | null = extractToolCall(e);
                if (toolCallInfo && isAssistantScopedPart) {
                    const toolCallId = toolCallInfo.toolCallId || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
                    if (!seenToolCallIds.has(toolCallId)) {
                        const toolKind = classifyToolKind(toolCallInfo.name);
                        toolKindsById.set(toolCallId, toolKind);
                        if (toolKind === 'read') {
                            seenReadOnlyToolCall = true;
                        } else if (toolKind === 'edit') {
                            seenEditToolCall = true;
                        }
                        if (waitingForToolContinuation) {
                            waitingForToolContinuation = false;
                        }
                        logSession(`tool_call name=${toolCallInfo.name} id=${toolCallId} kind=${toolKind}`);
                        seenToolCallIds.add(toolCallId);
                        toolCallCount++;
                        sm.dispatch({ kind: 'TOOL_CALL', name: toolCallInfo.name, toolCallId });
                        this.callbacks?.onToolCall?.(toolCallInfo.name, toolCallInfo.params, toolCallId);
                        this.callbacks?.onEvent?.('step_update', {
                            step: 'tool_call',
                            detail: `${toolCallInfo.name}`,
                        });
                    }
                }

                if (e.type === 'diff' && typeof (e as any).path === 'string') {
                    this.callbacks?.onDiff?.(
                        (e as any).path,
                        typeof (e as any).oldText === 'string' ? (e as any).oldText : '',
                        typeof (e as any).newText === 'string' ? (e as any).newText : '',
                        typeof (e as any).toolCallId === 'string' ? (e as any).toolCallId : 'opencode_diff',
                    );
                }

                const toolResultInfo: ToolResultInfo | null = extractToolResult(e);
                if (toolResultInfo && isAssistantScopedPart) {
                    const toolKind = toolKindsById.get(toolResultInfo.toolCallId) || 'other';
                    if (toolKind === 'edit' && !toolResultInfo.isError) {
                        seenEditToolResult = true;
                    }
                    logSession(
                        `tool_result id=${toolResultInfo.toolCallId} isError=${toolResultInfo.isError} kind=${toolKind}`,
                    );
                    sm.dispatch({ kind: 'TOOL_RESULT_SENT', toolCallId: toolResultInfo.toolCallId });
                    this.callbacks?.onToolResult?.(
                        toolResultInfo.toolCallId,
                        toolResultInfo.result,
                        toolResultInfo.isError,
                    );
                    this.callbacks?.onEvent?.('step_update', {
                        step: 'tool_result',
                        detail: toolResultInfo.isError ? 'error' : 'success',
                    });
                    if (toolResultInfo.isError) {
                        recordErrorMessage(`Tool failed: ${toolResultInfo.result}`);
                    }
                } else {
                }

                if (isCompletionEvent(e)) {
                    const finishReason = extractAssistantFinishReason(e);
                    if (finishReason) {
                        lastAssistantFinishReason = finishReason;
                    }
                    if (messageRole === 'assistant' && eventMessageId) {
                        completedAssistantMessageId = eventMessageId;
                    }
                    if (messageRole === 'assistant') {
                        logSession(
                            `assistant_completed message=${eventMessageId || 'unknown'} finish=${finishReason || 'none'} readOnly=${seenReadOnlyToolCall} editTool=${seenEditToolCall} editResult=${seenEditToolResult}`,
                        );
                    }
                    if (
                        isToolCallContinuationBoundary(e)
                        && !seenEditToolCall
                        && !seenEditToolResult
                        && !hasDiskChanged()
                    ) {
                        waitingForToolContinuation = true;
                        logSession(
                            `waiting_for_continuation reason=tool-calls-without-edit message=${eventMessageId || 'unknown'}`,
                        );
                        this.callbacks?.onEvent?.('status', {
                            phase: 'running',
                            message: 'Waiting for OpenCode to continue after read-only tool call...',
                        });
                        return;
                    }
                    // Hard terminal events advance to final disk verification.
                    // Assistant finish="tool-calls" is only allowed through
                    // here after an edit-capable tool or real disk change;
                    // read-only tool boundaries keep streaming instead.
                    sm.dispatch({ kind: 'TERMINAL_EVENT', reason: 'done' });
                    this.callbacks?.onEvent?.('status', {
                        phase: 'finalizing',
                        message: 'Verifying changes...',
                    });
                    void finalize();
                } else {
                }
            });

            this.transport.onClose((_exitCode: number | null) => {
                // Tell the SM the wire closed, with the truth about whether a
                // hard terminal was previously seen. SM uses this to decide
                // streaming -> error (no terminal) vs streaming -> streaming
                // (terminal already advanced state to applying_patch).
                sm.dispatch({ kind: 'TRANSPORT_CLOSED', sawTerminal: sawHardTerminal() });
                void finalize();
            });

            this.transport.onError((error: Error) => {
                transportError = error;
                sm.dispatch({ kind: 'TRANSPORT_ERROR', reason: error.message });
                if (!finalized) {
                    finalized = true;
                    clearTimeout(timeoutId);
                    store.dispose();
                    this.callbacks?.onEvent?.('session_end', {
                        success: false,
                        outcome: 'failed',
                        finalMessage: `Transport error: ${transportError.message}`,
                    });
                }
                reject(new Error('Transport error: ' + error.message));
            });

            this.transport.onProgress((progressMessage: string) => {
                this.callbacks?.onEvent?.('status', {
                    phase: 'running',
                    message: progressMessage,
                });
                this.callbacks?.onMessageChunk?.(
                    { type: 'text_delta', delta: `[${progressMessage}]\n` },
                    messageId + '_progress',
                );
            });

            this.transport.start(options.prompt);

            this.callbacks?.onEvent?.('status', {
                phase: 'running',
                message: 'Repairing with OpenCode...',
            });
        });
    }
}
