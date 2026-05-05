import { extractSessionId, isCompletionEvent, OpenCodeEvent } from './opencodeEventAdapter';
import {
    OpenCodePromptBody,
    OpenCodeSdkClient,
} from './opencodeSdkClient';
import {
    OpenCodeServerManager,
    OpenCodeServerManagerConfig,
    TransportLogger,
} from './opencodeServerManager';

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
            apiKey: this.config.apiKey,
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
        if (!this.sessionId) {
            this.pendingSessionEvents.push(event);
            return;
        }
        if (!this.shouldEmitEventForSession(event)) {
            return;
        }
        this.emitEvent(event);
        if (this.isCompletionLikeEvent(event)) {
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
            this.emitEvent(event);
            if (this.isCompletionLikeEvent(event)) {
                this.scheduleCompletionClose();
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

    private isCompletionLikeEvent(event: unknown): boolean {
        if (!event || typeof event !== 'object') {
            return false;
        }
        return isCompletionEvent(event as OpenCodeEvent);
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
