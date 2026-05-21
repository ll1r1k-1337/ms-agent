import {
    extractAssistantFinishReason,
    extractMessageId,
    extractSessionId,
    extractToolCall,
    extractToolResult,
    isCompletionEvent,
    isToolCallContinuationBoundary,
    extractPermissionRequest,
    PermissionRequestInfo,
    OpenCodeEvent,
} from './opencodeEventAdapter';
import {
    OpenCodePromptBody,
    OpenCodeSdkClient,
} from './opencodeSdkClient';
import {
    OpenCodeServerManager,
    OpenCodeServerManagerConfig,
    TransportLogger,
} from './opencodeServerManager';
import { logRawEvent, RawEventDisposition } from '../vscode/rawEventChannel';

export interface OpenCodeTurnRunnerConfig extends OpenCodeServerManagerConfig {
    model?: string;
    providerID?: string;
    modelFullName?: string;
}

export interface OpenCodeTurnRunnerCallbacks {
    onEvent?: (event: unknown) => void;
    onProgress?: (message: string) => void;
    onError?: (error: Error) => void;
    onClose?: (exitCode: number | null) => void;
}

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

function isRecordLike(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
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

// Paths that look like credential / secret stores. A permission request for
// one of these is rejected even under auto-approve, so the repair agent can
// never pull API keys or private keys into the model's context.
const SECRET_PATH_RE =
    /(^|\/)\.ssh\/|(^|\/)\.aws\/|(^|\/)\.gnupg\/|auth\.json|\.netrc|id_rsa\b|id_ed25519\b|credentials|(^|\/)\.env(\.|\/|$)/i;

/**
 * Decide how to answer a `permission.asked` request. The repair agent often
 * needs to read reference material outside the project directory (CANN SDK
 * headers, example kernels); without an answer those reads stall until the
 * hard timeout. Approve `once` (no persisted rule) — except when the target
 * path looks like a credential store, which is rejected.
 */
function decidePermission(request: PermissionRequestInfo): 'once' | 'reject' {
    const haystack = `${request.filepath} ${request.patterns.join(' ')}`;
    return SECRET_PATH_RE.test(haystack) ? 'reject' : 'once';
}

function getConfiguredModel(
    config: OpenCodeTurnRunnerConfig,
): { providerID: string; modelID: string; displayName: string } | null {
    if (!config.providerID || !config.model) {
        return null;
    }
    return {
        providerID: config.providerID,
        modelID: config.model,
        displayName: config.modelFullName || `${config.providerID}/${config.model}`,
    };
}

function buildPromptBody(
    config: OpenCodeTurnRunnerConfig,
    prompt: string,
): OpenCodePromptBody | null {
    const model = getConfiguredModel(config);
    if (!model) {
        return null;
    }
    return {
        model: {
            providerID: model.providerID,
            modelID: model.modelID,
        },
        parts: [{ type: 'text', text: prompt }],
    };
}

export class OpenCodeTurnRunner {
    private readonly config: OpenCodeTurnRunnerConfig;
    private readonly logger?: TransportLogger;
    private readonly serverManager: OpenCodeServerManager;
    private readonly callbacks: OpenCodeTurnRunnerCallbacks;
    private hardTimeoutId: NodeJS.Timeout | null = null;
    private softCloseTimer: NodeJS.Timeout | null = null;
    private abortCloseTimer: NodeJS.Timeout | null = null;
    private disposed = false;
    private aborted = false;
    private closeEmitted = false;
    private sessionId: string | null = null;
    private pendingSessionEvents: unknown[] = [];
    private eventSubscriptionClose: (() => void) | null = null;
    private sdkClient: OpenCodeSdkClient | null = null;
    private seenReadOnlyToolCall = false;
    private seenEditToolCall = false;
    private seenEditToolResult = false;
    private seenFileChangeSignal = false;
    private readonly toolKindsById = new Map<string, ToolKind>();
    private readonly respondedPermissionIds = new Set<string>();

    constructor(
        config: OpenCodeTurnRunnerConfig,
        callbacks: OpenCodeTurnRunnerCallbacks,
        logger?: TransportLogger,
    ) {
        this.config = config;
        this.callbacks = callbacks;
        this.logger = logger;
        this.serverManager = new OpenCodeServerManager(config, logger);
    }

    start(prompt: string): void {
        if (this.disposed) {
            this.emitError(new Error('Transport has been disposed'));
            return;
        }
        void this.run(prompt);
    }

    async readSessionMessages(): Promise<unknown[] | null> {
        if (!this.sessionId || !this.sdkClient) {
            return null;
        }
        return this.sdkClient.readSessionMessages(this.sessionId);
    }

    cancel(): void {
        if (this.disposed || this.aborted) {
            return;
        }
        this.aborted = true;
        this.emitProgress('Stopping the current OpenCode repair...');
        if (this.sessionId && this.sdkClient) {
            void this.sdkClient.abortSession(this.sessionId).catch((error) => {
                this.logger?.(`[OpenCodeTurnRunner] abort failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
        this.abortCloseTimer = setTimeout(() => {
            this.eventSubscriptionClose?.();
            this.eventSubscriptionClose = null;
            this.clearTimers();
            this.emitClose(0);
        }, 500);
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.cancel();
        this.disposed = true;
        this.eventSubscriptionClose?.();
        this.eventSubscriptionClose = null;
        this.clearTimers();
    }

    private async run(prompt: string): Promise<void> {
        const port = this.config.servePort;
        if (port === undefined) {
            this.emitError(new Error('OpenCode serve port is required'));
            this.emitClose(1);
            return;
        }

        const promptBody = buildPromptBody(this.config, prompt);
        if (!promptBody) {
            const configured = this.config.modelFullName || this.config.model || '(empty)';
            this.emitError(
                new Error(
                    `msagent.modelName must be a full OpenCode model ID like "provider/model"; current value "${configured}" has no provider prefix. Refusing to use the OpenCode server default model.`,
                ),
            );
            this.emitClose(1);
            return;
        }

        this.emitProgress(`Starting OpenCode on port ${port}...`);
        this.emitProgress(`Using model ${promptBody.model.providerID}/${promptBody.model.modelID}.`);

        let baseUrl: string;
        try {
            baseUrl = await this.serverManager.ensureReady();
            this.emitProgress(`Connecting to OpenCode at ${baseUrl}...`);
        } catch (error) {
            this.emitError(error instanceof Error ? error : new Error(String(error)));
            this.emitClose(1);
            return;
        }

        if (this.disposed || this.aborted) {
            return;
        }

        this.sdkClient = new OpenCodeSdkClient({
            baseUrl,
            timeoutMs: this.config.timeoutMs,
        });

        this.setupHardTimeout();

        try {
            const subscription = await this.sdkClient.subscribeEvents();
            this.eventSubscriptionClose = subscription.close;
            void this.consumeEvents(subscription.stream);
        } catch (error) {
            this.emitError(error instanceof Error ? error : new Error(String(error)));
            this.emitClose(1);
            return;
        }

        if (this.disposed || this.aborted || !this.sdkClient) {
            return;
        }

        try {
            this.sessionId = await this.sdkClient.createSession();
            this.logger?.(`OpenCode session id: ${this.sessionId}`);
            this.emitEvent({ type: 'session_start', sessionId: this.sessionId });
            this.flushPendingSessionEvents();
            await this.sdkClient.promptSession(this.sessionId, promptBody);
            if (!this.aborted && !this.disposed) {
                this.emitProgress('Repair request sent. Waiting for OpenCode events...');
            }
        } catch (error) {
            this.emitError(error instanceof Error ? error : new Error(String(error)));
            this.emitClose(1);
        }
    }

    private async consumeEvents(stream: AsyncIterable<unknown>): Promise<void> {
        try {
            for await (const event of stream) {
                if (this.disposed || this.aborted) {
                    break;
                }
                this.handleEvent(event);
            }
            if (!this.aborted) {
                this.scheduleSoftClose();
            }
        } catch (error) {
            if (!this.aborted && !this.disposed) {
                this.emitError(
                    error instanceof Error
                        ? new Error(`OpenCode SDK event stream failed: ${error.message}`)
                        : new Error(`OpenCode SDK event stream failed: ${String(error)}`),
                );
                this.emitClose(1);
            }
        }
    }

    private handleEvent(event: unknown): void {
        this.recordRawEvent(event);
        if (!this.sessionId) {
            this.pendingSessionEvents.push(event);
            return;
        }
        // Answer permission prompts before the session-scope filter, so that
        // `task` subagent reads (which run in child sessions) are unblocked
        // too — the reply targets the request's own sessionID.
        this.maybeAutoRespondToPermission(event);
        if (!this.shouldEmitEventForSession(event)) {
            return;
        }
        this.trackRepairEvent(event);
        this.emitEvent(event);
        if (this.shouldCloseAfterCompletion(event)) {
            this.scheduleCompletionClose();
        }
    }

    private flushPendingSessionEvents(): void {
        if (!this.sessionId) {
            return;
        }
        const buffered = this.pendingSessionEvents;
        this.pendingSessionEvents = [];
        for (const event of buffered) {
            if (!this.shouldEmitEventForSession(event)) {
                continue;
            }
            this.trackRepairEvent(event);
            this.emitEvent(event);
            if (this.shouldCloseAfterCompletion(event)) {
                this.scheduleCompletionClose();
            }
        }
    }

    private trackRepairEvent(event: unknown): void {
        const toolCall = extractToolCall(event);
        if (toolCall) {
            const toolCallId = toolCall.toolCallId || 'unknown';
            const kind = classifyToolKind(toolCall.name);
            this.toolKindsById.set(toolCallId, kind);
            if (kind === 'read') {
                this.seenReadOnlyToolCall = true;
            } else if (kind === 'edit') {
                this.seenEditToolCall = true;
            }
        }

        const toolResult = extractToolResult(event);
        if (toolResult) {
            const kind = this.toolKindsById.get(toolResult.toolCallId) || 'other';
            if (kind === 'edit' && !toolResult.isError) {
                this.seenEditToolResult = true;
            }
        }

        if (isRecordLike(event)) {
            if (event.type === 'file.edited') {
                this.seenFileChangeSignal = true;
            }
            if (event.type === 'session.diff' && isRecordLike(event.properties)) {
                const diff = event.properties.diff;
                if (Array.isArray(diff) && diff.length > 0) {
                    this.seenFileChangeSignal = true;
                }
            }
        }
    }

    private shouldEmitEventForSession(event: unknown): boolean {
        if (!this.sessionId) {
            return false;
        }
        return extractSessionId(event as OpenCodeEvent) === this.sessionId;
    }

    private setupHardTimeout(): void {
        this.hardTimeoutId = setTimeout(() => {
            if (this.aborted || this.disposed) {
                return;
            }
            this.cancel();
            this.emitError(
                new Error(
                    `OpenCode server request reached hard timeout after ${this.config.timeoutMs / 1000}s.`,
                ),
            );
        }, this.config.timeoutMs);
    }

    private clearTimers(): void {
        if (this.hardTimeoutId) {
            clearTimeout(this.hardTimeoutId);
            this.hardTimeoutId = null;
        }
        if (this.softCloseTimer) {
            clearTimeout(this.softCloseTimer);
            this.softCloseTimer = null;
        }
        if (this.abortCloseTimer) {
            clearTimeout(this.abortCloseTimer);
            this.abortCloseTimer = null;
        }
    }

    private scheduleSoftClose(): void {
        if (this.softCloseTimer || this.closeEmitted) {
            return;
        }
        this.softCloseTimer = setTimeout(() => {
            this.clearTimers();
            this.emitClose(0);
        }, 750);
    }

    private scheduleCompletionClose(): void {
        if (this.closeEmitted) {
            return;
        }
        if (this.softCloseTimer) {
            clearTimeout(this.softCloseTimer);
            this.softCloseTimer = null;
        }
        this.softCloseTimer = setTimeout(() => {
            this.clearTimers();
            this.emitClose(0);
        }, 250);
    }

    private shouldCloseAfterCompletion(event: unknown): boolean {
        if (!this.isCompletionLikeEvent(event)) {
            return false;
        }
        const openCodeEvent = event as OpenCodeEvent;
        if (
            isToolCallContinuationBoundary(openCodeEvent)
            && !this.seenEditToolResult
            && !this.seenFileChangeSignal
        ) {
            this.logger?.(
                `[OpenCodeTurnRunner] keeping event stream open after read-only tool boundary session=${this.sessionId || 'unknown'} message=${extractMessageId(openCodeEvent) || 'unknown'} finish=${extractAssistantFinishReason(openCodeEvent) || 'none'} readOnly=${this.seenReadOnlyToolCall} editTool=${this.seenEditToolCall} editResult=${this.seenEditToolResult}`,
            );
            return false;
        }
        return true;
    }

    private isCompletionLikeEvent(event: unknown): boolean {
        if (!event || typeof event !== 'object') {
            return false;
        }
        return isCompletionEvent(event as OpenCodeEvent);
    }

    /**
     * Mirror every event pulled off the SSE stream to the raw-events channel,
     * verbatim, before the session-scoping filter runs. Runners share one
     * OpenCode server, so each `/event` subscription sees every session's
     * events plus server-wide frames like `server.heartbeat`; the disposition
     * tag records what this runner did with each one. Pure observability — it
     * must never throw and never influence protocol decisions.
     */
    private recordRawEvent(event: unknown): void {
        try {
            let disposition: RawEventDisposition;
            if (!this.sessionId) {
                disposition = 'buffered';
            } else if (this.shouldEmitEventForSession(event)) {
                disposition = 'emit';
            } else {
                disposition = 'skip';
            }
            logRawEvent(event, { runnerSessionId: this.sessionId, disposition });
        } catch {
            // Observability must never break a repair.
        }
    }

    /**
     * Auto-answer OpenCode `permission.asked` events. A gated tool call
     * (commonly a `read` outside the project dir) stalls until the hard
     * timeout if nobody replies — msAgent runs the server non-interactively,
     * so there is no user to click "allow". We answer on the user's behalf:
     * approve `once`, except for credential-looking paths (see
     * decidePermission). Fire-and-forget — a failed reply is logged, never
     * fatal, and never influences protocol/terminal state.
     */
    private maybeAutoRespondToPermission(event: unknown): void {
        const request = extractPermissionRequest(event);
        if (!request || !this.sdkClient) {
            return;
        }
        if (this.respondedPermissionIds.has(request.permissionId)) {
            return;
        }
        this.respondedPermissionIds.add(request.permissionId);
        const decision = decidePermission(request);
        this.logger?.(
            `[OpenCodeTurnRunner] permission.asked id=${request.permissionId}`
            + ` session=${request.sessionId} permission=${request.permission || 'unknown'}`
            + ` path=${request.filepath || request.patterns[0] || 'unknown'} -> ${decision}`,
        );
        void this.sdkClient
            .respondToPermission(request.sessionId, request.permissionId, decision)
            .catch((error) => {
                this.logger?.(
                    `[OpenCodeTurnRunner] permission respond failed id=${request.permissionId}: `
                    + (error instanceof Error ? error.message : String(error)),
                );
            });
    }

    private emitEvent(event: unknown): void {
        this.callbacks.onEvent?.(event);
    }

    private emitProgress(message: string): void {
        this.callbacks.onProgress?.(message);
    }

    private emitError(error: Error): void {
        this.callbacks.onError?.(error);
    }

    private emitClose(exitCode: number | null): void {
        if (this.closeEmitted) {
            return;
        }
        this.closeEmitted = true;
        this.callbacks.onClose?.(exitCode);
    }
}
