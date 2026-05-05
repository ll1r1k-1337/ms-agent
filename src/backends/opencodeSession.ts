import * as fs from 'fs';
import { ExplanationKind, FixOutcome, FixResult } from './fixBackend';
import { OpenCodeTransport } from './opencodeTransport';
import { StreamChunk } from '../llm/types';
import {
    extractToolCall,
    extractToolResult,
    extractTextDelta,
    extractErrorMessage,
    extractSessionId,
    isCompletionEvent,
    extractMessageId,
    extractMessageRole,
    extractPartMessageId,
    ToolCallInfo,
    ToolResultInfo,
    OpenCodeEvent,
} from './opencodeEventAdapter';
import { SessionStateMachine } from '../agent/sessionStateMachine';
import { DisposableStore } from '../agent/disposableStore';

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
    if (looksLikeProcessNarration(trimmed)) {
        return null;
    }
    return { text: trimmed, kind: 'plain' };
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

                const normalizedOriginal = options.originalContent.replace(/\r\n/g, '\n').trim();

                let diskContent: string | null = null;
                try {
                    diskContent = fs.readFileSync(options.resolvedPath, 'utf-8');
                } catch (err) {
                }

                if (diskContent !== null) {
                    const normalizedDisk = diskContent.replace(/\r\n/g, '\n').trim();
                    if (normalizedDisk !== normalizedOriginal) {
                        const streamExplanation = extractAssistantExplanationFromTextMap(
                            messageTexts,
                            assistantMessageOrder,
                            completedAssistantMessageId,
                        );
                        const sessionMessages = streamExplanation
                            ? null
                            : await this.transport.readSessionMessages();
                        const assistantExplanation =
                            streamExplanation
                            || extractAssistantExplanationFromSessionMessages(
                                sessionMessages,
                                completedAssistantMessageId,
                            )
                            || missingExplanation();
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

                    if (normalizedOriginal !== normalizedFixed) {
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
                    const opencodeSessionId = extractSessionId(e);
                    if (opencodeSessionId) {
                        this.callbacks?.onEvent?.('session_metadata', { opencodeSessionId });
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
                    if (messageRole === 'assistant' && eventMessageId) {
                        completedAssistantMessageId = eventMessageId;
                    }
                    // After the adapter tightening, this branch fires ONLY on
                    // hard terminal events (done / step_end / session.end /
                    // session.done / message.updated:info.time.completed /
                    // choices[0].finish_reason). Soft signals like session.idle
                    // / server.disconnect no longer reach here — they bypass
                    // this branch and only affect transport.onClose handling.
                    // SM observer flips observedHardTerminal when state -> applying_patch.
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
