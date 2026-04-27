import * as child_process from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { extractSessionId, isCompletionEvent, OpenCodeEvent } from './opencodeEventAdapter';

const _deps = {
    spawn: child_process.spawn,
    httpRequest: http.request,
};

export function _setTestDeps(deps: Partial<typeof _deps>) {
    Object.assign(_deps, deps);
}

export function _resetTestDeps() {
    _deps.spawn = child_process.spawn;
    _deps.httpRequest = http.request;
    for (const managed of managedServers.values()) {
        if (managed.child && !managed.child.killed) {
            managed.child.kill('SIGTERM');
        }
    }
    managedServers.clear();
}

export interface OpenCodeTransport {
    start(prompt: string): void;
    onEvent(callback: (event: unknown) => void): void;
    onProgress(callback: (message: string) => void): void;
    onError(callback: (error: Error) => void): void;
    onClose(callback: (exitCode: number | null) => void): void;
    send(data: unknown): void;
    readSessionMessages(): Promise<unknown[] | null>;
    cancel(): void;
    dispose(): void;
}

export interface OpenCodeTransportConfig {
    mode: 'server' | 'acp';
    cliPath?: string;
    servePort?: number;
    acpArgs?: string[];
    apiKey?: string;
    workspaceRoot?: string;
    timeoutMs: number;
    model?: string;
    providerID?: string;
    modelFullName?: string;
}

export type TransportLogger = (message: string) => void;

interface OpenCodePromptBody {
    model: {
        providerID: string;
        modelID: string;
    };
    parts: Array<{ type: 'text'; text: string }>;
}

interface ManagedServer {
    child?: child_process.ChildProcess;
    readyPromise: Promise<void>;
    ready: boolean;
}

interface PendingRpc {
    method: string;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
}

interface ManagedTerminal {
    id: string;
    child: child_process.ChildProcess;
    output: string;
    truncated: boolean;
    outputByteLimit: number;
    exitStatus: { exitCode: number | null; signal: NodeJS.Signals | null } | null;
    waiters: Array<(status: { exitCode: number | null; signal: NodeJS.Signals | null }) => void>;
}

const managedServers = new Map<string, ManagedServer>();

function isRecordLike(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

export function disposeAllManagedServers(): void {
    for (const [key, managed] of managedServers.entries()) {
        if (managed.child && !managed.child.killed) {
            managed.child.kill('SIGTERM');
        }
        managedServers.delete(key);
    }
}

function getCliPath(config: OpenCodeTransportConfig): string {
    return config.cliPath || 'opencode';
}

function getServerKey(config: OpenCodeTransportConfig): string {
    return `${getCliPath(config)}::${config.servePort ?? 'default'}`;
}

function wrapSpawnError(err: unknown, cliPath: string): Error {
    if (err instanceof Error && err.message.includes('ENOENT')) {
        return new Error(
            `OpenCode CLI not found at: ${cliPath}. Please install OpenCode or set correct path in settings.`,
        );
    }
    const message = err instanceof Error ? err.message : String(err);
    return new Error(`Failed to run OpenCode: ${message}`);
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function probePort(port: number, timeoutMs = 500): Promise<boolean> {
    return new Promise((resolve) => {
        const req = _deps.httpRequest(
            {
                hostname: '127.0.0.1',
                port,
                path: '/global/health',
                method: 'GET',
                timeout: timeoutMs,
            },
            (res) => {
                if (typeof (res as any).resume === 'function') {
                    (res as any).resume();
                }
                resolve(true);
            },
        );

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.end();
    });
}

function waitForServerReady(
    port: number,
    timeoutMs: number,
    logger?: TransportLogger,
): Promise<void> {
    const startedAt = Date.now();

    const attempt = (): Promise<void> => new Promise((resolve, reject) => {
        const req = _deps.httpRequest(
            {
                hostname: '127.0.0.1',
                port,
                path: '/',
                method: 'GET',
                timeout: 1000,
            },
            (res) => {
                if (typeof (res as any).resume === 'function') {
                    (res as any).resume();
                }
                resolve();
            },
        );

        req.on('error', async (err: Error) => {
            if (Date.now() - startedAt >= timeoutMs) {
                reject(
                    new Error(
                        `OpenCode server did not become ready on port ${port} within ${timeoutMs}ms. Error: ${err.message}`,
                    ),
                );
                return;
            }
            logger?.(`OpenCode server not ready yet on port ${port}: ${err.message}`);
            await wait(250);
            try {
                await attempt();
                resolve();
            } catch (inner) {
                reject(inner);
            }
        });

        req.on('timeout', async () => {
            req.destroy();
            if (Date.now() - startedAt >= timeoutMs) {
                reject(
                    new Error(
                        `OpenCode server did not become ready on port ${port} within ${timeoutMs}ms.`,
                    ),
                );
                return;
            }
            logger?.(`OpenCode server readiness probe timed out on port ${port}`);
            await wait(250);
            try {
                await attempt();
                resolve();
            } catch (inner) {
                reject(inner);
            }
        });

        req.end();
    });

    return attempt();
}

async function ensureManagedServer(
    config: OpenCodeTransportConfig,
    logger?: TransportLogger,
): Promise<ManagedServer> {
    const port = config.servePort;
    if (port === undefined) {
        throw new Error('Server port is required for server mode');
    }

    const key = getServerKey(config);
    const existing = managedServers.get(key);
    if (existing) {
        logger?.(`Reusing existing OpenCode server on port ${port}`);
        await existing.readyPromise;
        return existing;
    }

    if (await probePort(port, 500)) {
        logger?.(`OpenCode server already listening on port ${port}, reusing`);
        const managed: ManagedServer = {
            ready: true,
            readyPromise: Promise.resolve(),
        };
        managedServers.set(key, managed);
        return managed;
    }

    const cliPath = getCliPath(config);
    let child: child_process.ChildProcess;
    try {
        child = _deps.spawn(cliPath, ['serve', '--port', String(port)], {
            timeout: config.timeoutMs,
            env: {
                ...process.env,
                ...(config.apiKey ? { OPENCODE_API_KEY: config.apiKey } : {}),
            },
        });
    } catch (err) {
        throw wrapSpawnError(err, cliPath);
    }

    const managed: ManagedServer = {
        child,
        ready: false,
        readyPromise: Promise.resolve(),
    };

    const cleanup = (): void => {
        managedServers.delete(key);
    };

    child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
            logger?.(`OpenCode serve stdout: ${text.substring(0, 200)}`);
        }
    });

    child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
            logger?.(`OpenCode serve stderr: ${text.substring(0, 200)}`);
        }
    });

    child.on('error', (err: Error) => {
        logger?.(`OpenCode serve process error: ${err.message}`);
        cleanup();
    });

    child.on('close', (exitCode: number | null) => {
        logger?.(`OpenCode serve process exited with code ${exitCode}`);
        cleanup();
    });

    managed.readyPromise = waitForServerReady(port, Math.min(config.timeoutMs, 15000), logger)
        .then(() => {
            managed.ready = true;
            logger?.(`OpenCode server is ready on port ${port}`);
        })
        .catch((error) => {
            cleanup();
            if (!child.killed) {
                child.kill('SIGTERM');
            }
            throw error;
        });

    managedServers.set(key, managed);
    await managed.readyPromise;
    return managed;
}

class ServeTransport implements OpenCodeTransport {
    private readonly config: OpenCodeTransportConfig;
    private readonly logger?: TransportLogger;
    private eventCallback: ((event: unknown) => void) | null = null;
    private progressCallback: ((message: string) => void) | null = null;
    private errorCallback: ((error: Error) => void) | null = null;
    private closeCallback: ((exitCode: number | null) => void) | null = null;
    private hardTimeoutId: NodeJS.Timeout | null = null;
    private softCloseTimer: NodeJS.Timeout | null = null;
    private abortCloseTimer: NodeJS.Timeout | null = null;
    private disposed = false;
    private sessionId: string | null = null;
    private aborted = false;
    private sseReq: http.ClientRequest | null = null;
    private sseActive = false;
    private closeEmitted = false;
    private pendingSessionEvents: unknown[] = [];

    constructor(config: OpenCodeTransportConfig, logger?: TransportLogger) {
        this.config = config;
        this.logger = logger;
    }

    start(prompt: string): void {
        if (this.disposed) {
            this.emitError(new Error('Transport has been disposed'));
            return;
        }
        void this.runViaHttpApi(prompt);
    }

    onEvent(callback: (event: unknown) => void): void {
        this.eventCallback = callback;
    }

    onProgress(callback: (message: string) => void): void {
        this.progressCallback = callback;
    }

    onError(callback: (error: Error) => void): void {
        this.errorCallback = callback;
    }

    onClose(callback: (exitCode: number | null) => void): void {
        this.closeCallback = callback;
    }

    send(_data: unknown): void {
        this.logger?.('[ServeTransport] send ignored; OpenCode manages its own native tools in server mode');
    }

    async readSessionMessages(): Promise<unknown[] | null> {
        if (!this.sessionId) {
            return null;
        }
        const response = await this.httpGet(`/session/${this.sessionId}/message`, true, true);
        return this.normalizeSessionMessages(response);
    }

    cancel(): void {
        if (this.disposed || this.aborted) {
            return;
        }
        this.aborted = true;
        this.emitProgress('Cancelling OpenCode server session...');
        if (this.sessionId) {
            void this.abortSession(this.sessionId);
        }
        this.abortCloseTimer = setTimeout(() => {
            if (this.sseReq) {
                this.sseReq.destroy();
                this.sseReq = null;
            }
            this.sseActive = false;
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
        if (this.sseReq) {
            this.sseReq.destroy();
            this.sseReq = null;
        }
        this.sseActive = false;
        this.clearTimers();
        this.eventCallback = null;
        this.progressCallback = null;
        this.errorCallback = null;
        this.closeCallback = null;
    }

    private getBaseUrl(): string {
        const port = this.config.servePort ?? 7325;
        return `http://127.0.0.1:${port}`;
    }

    private getConfiguredModel(): { providerID: string; modelID: string; displayName: string } | null {
        if (!this.config.providerID || !this.config.model) {
            return null;
        }
        return {
            providerID: this.config.providerID,
            modelID: this.config.model,
            displayName: this.config.modelFullName || `${this.config.providerID}/${this.config.model}`,
        };
    }

    private buildPromptBody(prompt: string): OpenCodePromptBody | null {
        const model = this.getConfiguredModel();
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

    private async runViaHttpApi(prompt: string): Promise<void> {
        const port = this.config.servePort;
        if (port === undefined) {
            this.emitError(new Error('Server port is required for server mode'));
            return;
        }

        const promptBody = this.buildPromptBody(prompt);
        if (!promptBody) {
            const configured = this.config.modelFullName || this.config.model || '(empty)';
            this.emitError(
                new Error(
                    `msagent.modelName must be a full OpenCode model ID like "provider/model" for server mode; current value "${configured}" has no provider prefix. Refusing to use the OpenCode server default model.`,
                ),
            );
            this.emitClose(1);
            return;
        }

        this.emitProgress(`Connecting to OpenCode server on port ${port}...`);
        this.emitProgress(`OpenCode model: ${promptBody.model.providerID}/${promptBody.model.modelID}`);

        try {
            await ensureManagedServer(this.config, this.logger);
            this.emitProgress(`OpenCode server is ready on port ${port}`);
        } catch (error) {
            this.emitError(error instanceof Error ? error : new Error(String(error)));
            this.emitClose(1);
            return;
        }

        if (this.disposed || this.aborted) {
            return;
        }

        this.setupHardTimeout();

        try {
            await this.openEventStream('/event');
        } catch (error) {
            this.emitError(error instanceof Error ? error : new Error(String(error)));
            this.emitClose(1);
            return;
        }

        if (this.disposed || this.aborted) {
            return;
        }

        const session = await this.httpPost('/session', {});
        if (!session || this.aborted) {
            return;
        }

        this.sessionId = (session as any).id;
        if (!this.sessionId) {
            this.emitError(new Error('OpenCode server did not return a session ID'));
            this.emitClose(1);
            return;
        }

        this.logger?.(`OpenCode session id: ${this.sessionId}`);
        this.emitEvent({ type: 'session_start', sessionId: this.sessionId });
        this.flushPendingSessionEvents();

        const asyncAccepted = await this.httpPost(
            `/session/${this.sessionId}/prompt_async`,
            promptBody,
            true,
        );
        if (this.aborted || this.disposed) {
            return;
        }

        if (asyncAccepted !== null) {
            this.emitProgress('Prompt sent. Waiting for OpenCode server events...');
            return;
        }

        const messageResult = await this.httpPost(
            `/session/${this.sessionId}/message`,
            promptBody,
            true,
        );
        if (!messageResult || this.aborted) {
            return;
        }

        const parts = (messageResult as any).parts;
        if (Array.isArray(parts)) {
            for (const part of parts) {
                if (this.aborted) {
                    return;
                }
                this.emitEvent({ type: (part as any).type, part });
            }
        }
        this.emitEvent({ type: 'done' });
        this.scheduleCompletionClose();
    }

    private openEventStream(pathname: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this.aborted || this.disposed) {
                resolve();
                return;
            }

            const url = new URL(pathname, this.getBaseUrl());
            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
                },
                timeout: this.config.timeoutMs,
            };

            let settled = false;
            let lineBuffer = '';
            const settleResolve = (): void => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };
            const settleReject = (error: Error): void => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            };

            const req = _deps.httpRequest(options, (res) => {
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        settleReject(
                            new Error(
                                `OpenCode SSE endpoint returned HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`,
                            ),
                        );
                    });
                    return;
                }

                this.sseActive = true;
                res.setEncoding('utf8');
                settleResolve();

                res.on('data', (chunk: string) => {
                    lineBuffer += chunk;
                    let newlineIndex: number;
                    while ((newlineIndex = lineBuffer.indexOf('\n')) >= 0) {
                        const line = lineBuffer.substring(0, newlineIndex).trim();
                        lineBuffer = lineBuffer.substring(newlineIndex + 1);
                        if (!line) {
                            continue;
                        }

                        const jsonLine = line.startsWith('data: ') ? line.substring(6).trim() : line;
                        if (!jsonLine || jsonLine === '[DONE]') {
                            continue;
                        }

                        try {
                            this.handleSseEvent(JSON.parse(jsonLine));
                        } catch {
                            this.logger?.(`[ServeTransport] failed to parse SSE line: ${line.substring(0, 200)}`);
                        }
                    }
                });

                res.on('end', () => {
                    this.sseActive = false;
                    if (lineBuffer.trim()) {
                        const jsonLine = lineBuffer.trim().startsWith('data: ')
                            ? lineBuffer.trim().substring(6).trim()
                            : lineBuffer.trim();
                        if (jsonLine && jsonLine !== '[DONE]') {
                            try {
                                this.handleSseEvent(JSON.parse(jsonLine));
                            } catch {
                                this.logger?.(`[ServeTransport] failed to parse final SSE line: ${lineBuffer.substring(0, 200)}`);
                            }
                        }
                    }
                    if (!this.aborted) {
                        this.scheduleSoftClose();
                    }
                });

                res.on('error', (err: Error) => {
                    this.sseActive = false;
                    this.logger?.(`[ServeTransport] SSE response error: ${err.message}`);
                });
            });

            req.on('error', (err: Error) => {
                this.sseActive = false;
                if (!this.aborted) {
                    settleReject(new Error(`OpenCode SSE request failed: ${err.message}`));
                } else {
                    settleResolve();
                }
            });

            req.on('timeout', () => {
                req.destroy();
                this.sseActive = false;
                if (!this.aborted) {
                    settleReject(new Error('OpenCode SSE request timed out'));
                } else {
                    settleResolve();
                }
            });

            this.sseReq = req;
            req.end();
        });
    }

    private handleSseEvent(event: unknown): void {
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

    private async abortSession(sessionId: string): Promise<void> {
        await this.httpPost(`/session/${sessionId}/abort`, {}, true, true);
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

    private httpPost(
        pathname: string,
        body: unknown,
        silentErrors = false,
        allowWhenAborted = false,
    ): Promise<unknown> {
        return new Promise<unknown>((resolve) => {
            if ((this.aborted && !allowWhenAborted) || this.disposed) {
                resolve(null);
                return;
            }

            const url = new URL(pathname, this.getBaseUrl());
            const postData = JSON.stringify(body);
            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
                },
                timeout: this.config.timeoutMs,
            };

            const req = _deps.httpRequest(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                        if (!silentErrors) {
                            this.emitError(new Error(`OpenCode server returned HTTP ${res.statusCode} for ${pathname}`));
                        }
                        resolve(null);
                        return;
                    }
                    if (!raw.trim()) {
                        resolve({});
                        return;
                    }
                    try {
                        resolve(JSON.parse(raw));
                    } catch {
                        if (!silentErrors) {
                            this.emitError(new Error(`Failed to parse OpenCode server response from ${pathname}`));
                        }
                        resolve(null);
                    }
                });
            });

            req.on('error', (err: Error) => {
                if (!silentErrors && !this.aborted) {
                    this.emitError(new Error(`OpenCode server request failed: ${err.message}`));
                }
                resolve(null);
            });

            req.on('timeout', () => {
                req.destroy();
                if (!silentErrors && !this.aborted) {
                    this.emitError(new Error(`OpenCode server request timed out for ${pathname}`));
                }
                resolve(null);
            });

            req.write(postData);
            req.end();
        });
    }

    private httpGet(
        pathname: string,
        silentErrors = false,
        allowWhenAborted = false,
    ): Promise<unknown> {
        return new Promise<unknown>((resolve) => {
            if ((this.aborted && !allowWhenAborted) || this.disposed) {
                resolve(null);
                return;
            }

            const url = new URL(pathname, this.getBaseUrl());
            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
                },
                timeout: this.config.timeoutMs,
            };

            const req = _deps.httpRequest(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                        if (!silentErrors) {
                            this.emitError(new Error(`OpenCode server returned HTTP ${res.statusCode} for ${pathname}`));
                        }
                        resolve(null);
                        return;
                    }
                    if (!raw.trim()) {
                        resolve(null);
                        return;
                    }
                    try {
                        resolve(JSON.parse(raw));
                    } catch {
                        if (!silentErrors) {
                            this.emitError(new Error(`Failed to parse OpenCode server response from ${pathname}`));
                        }
                        resolve(null);
                    }
                });
            });

            req.on('error', (err: Error) => {
                if (!silentErrors && !this.aborted) {
                    this.emitError(new Error(`OpenCode server request failed: ${err.message}`));
                }
                resolve(null);
            });

            req.on('timeout', () => {
                req.destroy();
                if (!silentErrors && !this.aborted) {
                    this.emitError(new Error(`OpenCode server request timed out for ${pathname}`));
                }
                resolve(null);
            });

            req.end();
        });
    }

    private normalizeSessionMessages(response: unknown): unknown[] | null {
        if (Array.isArray(response)) {
            return response;
        }
        if (!isRecordLike(response)) {
            return null;
        }
        const candidates = [response.messages, response.items, response.data];
        for (const candidate of candidates) {
            if (Array.isArray(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private emitEvent(event: unknown): void {
        this.eventCallback?.(event);
    }

    private emitProgress(message: string): void {
        this.progressCallback?.(message);
    }

    private emitError(error: Error): void {
        this.errorCallback?.(error);
    }

    private emitClose(exitCode: number | null): void {
        if (this.closeEmitted) {
            return;
        }
        this.closeEmitted = true;
        this.closeCallback?.(exitCode);
    }
}

class AcpTransport implements OpenCodeTransport {
    private readonly config: OpenCodeTransportConfig;
    private readonly logger?: TransportLogger;
    private eventCallback: ((event: unknown) => void) | null = null;
    private progressCallback: ((message: string) => void) | null = null;
    private errorCallback: ((error: Error) => void) | null = null;
    private closeCallback: ((exitCode: number | null) => void) | null = null;
    private child: child_process.ChildProcess | null = null;
    private stdoutBuffer = '';
    private disposed = false;
    private closeEmitted = false;
    private nextRequestId = 0;
    private sessionId: string | null = null;
    private cancelRequested = false;
    private promptCompleted = false;
    private pending = new Map<number, PendingRpc>();
    private terminals = new Map<string, ManagedTerminal>();
    private abortCloseTimer: NodeJS.Timeout | null = null;

    constructor(config: OpenCodeTransportConfig, logger?: TransportLogger) {
        this.config = config;
        this.logger = logger;
    }

    start(prompt: string): void {
        if (this.disposed) {
            this.emitError(new Error('Transport has been disposed'));
            return;
        }
        void this.run(prompt);
    }

    onEvent(callback: (event: unknown) => void): void {
        this.eventCallback = callback;
    }

    onProgress(callback: (message: string) => void): void {
        this.progressCallback = callback;
    }

    onError(callback: (error: Error) => void): void {
        this.errorCallback = callback;
    }

    onClose(callback: (exitCode: number | null) => void): void {
        this.closeCallback = callback;
    }

    send(_data: unknown): void {
        this.logger?.('[AcpTransport] send ignored; OpenCode manages tool execution through ACP');
    }

    async readSessionMessages(): Promise<unknown[] | null> {
        return null;
    }

    cancel(): void {
        if (this.disposed || this.cancelRequested) {
            return;
        }
        this.cancelRequested = true;
        this.emitProgress('Cancelling OpenCode ACP turn...');
        if (this.sessionId) {
            this.sendNotification('session/cancel', { sessionId: this.sessionId });
        }
        this.abortCloseTimer = setTimeout(() => {
            if (this.child && !this.child.killed) {
                this.child.kill('SIGTERM');
            }
        }, 500);
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.abortCloseTimer) {
            clearTimeout(this.abortCloseTimer);
            this.abortCloseTimer = null;
        }
        for (const terminal of this.terminals.values()) {
            if (terminal.child && !terminal.child.killed) {
                terminal.child.kill('SIGTERM');
            }
        }
        this.terminals.clear();
        if (this.child && !this.child.killed) {
            this.child.kill('SIGTERM');
        }
        this.child?.stdout?.removeAllListeners();
        this.child?.stderr?.removeAllListeners();
        this.child?.removeAllListeners();
        this.child = null;
        this.rejectPending(new Error('ACP transport disposed'));
        this.eventCallback = null;
        this.progressCallback = null;
        this.errorCallback = null;
        this.closeCallback = null;
    }

    private async run(prompt: string): Promise<void> {
        const cliPath = getCliPath(this.config);
        const args = [...(this.config.acpArgs && this.config.acpArgs.length > 0 ? this.config.acpArgs : ['acp'])];
        if (this.config.workspaceRoot) {
            args.push('--cwd', this.config.workspaceRoot);
        }

        try {
            this.child = _deps.spawn(cliPath, args, {
                cwd: this.config.workspaceRoot,
                env: {
                    ...process.env,
                    ...(this.config.apiKey ? { OPENCODE_API_KEY: this.config.apiKey } : {}),
                },
            });
        } catch (err) {
            this.emitError(wrapSpawnError(err, cliPath));
            return;
        }

        this.setupProcessHandlers();

        try {
            const initResult = await this.sendRequest('initialize', {
                protocolVersion: 1,
                clientCapabilities: {
                    fs: { readTextFile: true, writeTextFile: true },
                    terminal: true,
                },
                clientInfo: {
                    name: 'msagent',
                    title: 'msAgent',
                    version: '0.4.0',
                },
            });

            this.logger?.(`[AcpTransport] initialize result ${JSON.stringify(initResult).substring(0, 400)}`);

            const sessionResult = await this.sendRequest('session/new', {
                cwd: this.config.workspaceRoot || process.cwd(),
                mcpServers: [],
            });

            this.sessionId = sessionResult?.sessionId;
            if (!this.sessionId) {
                throw new Error('ACP session/new did not return a sessionId');
            }

            this.logger?.(`OpenCode session id: ${this.sessionId}`);
            await this.applyConfiguredModel(sessionResult);
            this.emitEvent({ type: 'session_start', sessionId: this.sessionId });

            const promptResult = await this.sendRequest('session/prompt', {
                sessionId: this.sessionId,
                prompt: [{ type: 'text', text: prompt }],
            });

            this.promptCompleted = true;
            this.emitProgress(`ACP turn completed with stopReason=${promptResult?.stopReason ?? 'unknown'}`);
            this.emitEvent({ type: 'done', stopReason: promptResult?.stopReason });
            setTimeout(() => this.emitClose(0), 250);
        } catch (error) {
            if (!this.disposed) {
                this.emitError(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    private setupProcessHandlers(): void {
        if (!this.child) {
            return;
        }

        this.child.stdout?.on('data', (data: Buffer) => {
            this.stdoutBuffer += data.toString('utf8');
            let newlineIndex: number;
            while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) >= 0) {
                const line = this.stdoutBuffer.substring(0, newlineIndex).trim();
                this.stdoutBuffer = this.stdoutBuffer.substring(newlineIndex + 1);
                if (!line) {
                    continue;
                }
                try {
                    this.handleRpcMessage(JSON.parse(line));
                } catch {
                    this.logger?.(`[AcpTransport] failed to parse line: ${line.substring(0, 200)}`);
                }
            }
        });

        this.child.stderr?.on('data', (data: Buffer) => {
            const text = data.toString().trim();
            if (text) {
                this.emitProgress(text.substring(0, 300));
            }
        });

        this.child.on('error', (err: Error) => {
            if (!this.disposed) {
                this.emitError(wrapSpawnError(err, getCliPath(this.config)));
            }
        });

        this.child.on('close', (exitCode: number | null) => {
            this.rejectPending(new Error(`ACP process exited with code ${exitCode}`));
            this.emitClose(exitCode);
        });
    }

    private handleRpcMessage(message: any): void {
        if (typeof message?.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
            const pending = this.pending.get(message.id);
            if (!pending) {
                return;
            }
            this.pending.delete(message.id);
            if (message.error) {
                pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
            } else {
                pending.resolve(message.result);
            }
            return;
        }

        if (typeof message?.method === 'string') {
            if (message.method === 'session/update') {
                void this.handleSessionUpdate(message.params?.update);
                return;
            }

            if (typeof message.id === 'number') {
                void this.handleAgentRequest(message);
            }
        }
    }

    private async handleAgentRequest(message: any): Promise<void> {
        const id = message.id;
        const method = message.method;
        const params = message.params || {};

        try {
            switch (method) {
                case 'session/request_permission':
                    this.respond(id, await this.handlePermissionRequest(params));
                    return;
                case 'fs/read_text_file':
                    this.respond(id, { content: await this.readTextFile(params) });
                    return;
                case 'fs/write_text_file':
                    await this.writeTextFile(params);
                    this.respond(id, null);
                    return;
                case 'terminal/create':
                    this.respond(id, { terminalId: await this.createTerminal(params) });
                    return;
                case 'terminal/output':
                    this.respond(id, this.getTerminalOutput(params.terminalId));
                    return;
                case 'terminal/wait_for_exit':
                    this.respond(id, { exitStatus: await this.waitForTerminalExit(params.terminalId) });
                    return;
                case 'terminal/kill':
                    await this.killTerminal(params.terminalId);
                    this.respond(id, null);
                    return;
                case 'terminal/release':
                    await this.releaseTerminal(params.terminalId);
                    this.respond(id, null);
                    return;
                default:
                    this.respondError(id, -32601, `Unsupported ACP client method: ${method}`);
            }
        } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            this.respondError(id, -32000, messageText);
        }
    }

    private async applyConfiguredModel(sessionResult: any): Promise<void> {
        if (!this.sessionId || !this.config.model) {
            return;
        }

        const configOptions = Array.isArray(sessionResult?.configOptions)
            ? sessionResult.configOptions
            : [];
        const modelOption = configOptions.find((option: any) => {
            return option && (option.id === 'model' || option.category === 'model');
        });

        const modelCandidates = this.getModelCandidates();
        if (!modelOption || modelCandidates.includes(String(modelOption.currentValue ?? ''))) {
            return;
        }

        const options = Array.isArray(modelOption.options) ? modelOption.options : [];
        const requestedModel = modelCandidates.find((candidate) =>
            options.some((option: any) => option?.value === candidate),
        );
        if (!requestedModel) {
            const requested = this.config.modelFullName || this.config.model;
            this.emitProgress(`ACP agent does not advertise model "${requested}", keeping ${modelOption.currentValue ?? 'default'}.`);
            return;
        }

        await this.sendRequest('session/set_config_option', {
            sessionId: this.sessionId,
            configId: modelOption.id,
            value: requestedModel,
        });
        this.emitProgress(`ACP session model set to ${requestedModel}.`);
    }

    private getModelCandidates(): string[] {
        const candidates = [
            this.config.modelFullName,
            this.config.providerID && this.config.model ? `${this.config.providerID}/${this.config.model}` : undefined,
            this.config.model,
        ];
        const seen = new Set<string>();
        const result: string[] = [];
        for (const candidate of candidates) {
            if (!candidate || seen.has(candidate)) {
                continue;
            }
            seen.add(candidate);
            result.push(candidate);
        }
        return result;
    }

    private async handlePermissionRequest(params: any): Promise<any> {
        if (this.cancelRequested) {
            return { outcome: { outcome: 'cancelled' } };
        }

        const options = Array.isArray(params?.options) ? params.options : [];
        const preferred =
            options.find((option: any) => option?.kind === 'allow_once')
            ?? options.find((option: any) => option?.kind === 'allow_always')
            ?? options[0];

        const label = params?.toolCall?.title || params?.toolCall?.kind || params?.toolCall?.toolCallId || 'tool call';
        this.emitProgress(`Auto-approving ACP permission request for ${label}.`);

        if (!preferred?.optionId) {
            return { outcome: { outcome: 'cancelled' } };
        }

        return {
            outcome: {
                outcome: 'selected',
                optionId: preferred.optionId,
            },
        };
    }

    private async handleSessionUpdate(update: any): Promise<void> {
        if (!update || typeof update !== 'object') {
            return;
        }

        const kind = update.sessionUpdate;
        switch (kind) {
            case 'agent_message_chunk': {
                const text = this.extractContentText(update.content);
                if (text) {
                    this.emitEvent({
                        type: 'text',
                        part: { text },
                        messageId: update.messageId,
                    });
                }
                return;
            }
            case 'agent_thought_chunk': {
                const text = this.extractContentText(update.content);
                if (text) {
                    this.emitEvent({
                        type: 'reasoning',
                        part: { text },
                        messageId: update.messageId,
                    });
                }
                return;
            }
            case 'tool_call': {
                const toolCallId = update.toolCallId || `acp_${Date.now()}`;
                const params = this.extractToolParams(update);
                this.emitEvent({
                    type: 'tool_call',
                    tool_call: {
                        id: toolCallId,
                        name: update.title || update.kind || 'tool',
                        arguments: JSON.stringify(params),
                    },
                });
                this.emitEmbeddedContent(update.content, toolCallId);
                return;
            }
            case 'tool_call_update': {
                const toolCallId = update.toolCallId || `acp_${Date.now()}`;
                this.emitEmbeddedContent(update.content, toolCallId);
                const status = typeof update.status === 'string' ? update.status : '';
                if (status === 'completed' || status === 'failed' || status === 'cancelled') {
                    const resultText = this.extractContentTextList(update.content).join('\n') || `Status: ${status}`;
                    this.emitEvent({
                        type: 'tool_result',
                        tool_result: {
                            toolCallId,
                            result: resultText,
                            isError: status !== 'completed',
                        },
                    });
                }
                return;
            }
            case 'plan':
                this.emitProgress('Received ACP plan update.');
                return;
            default:
                return;
        }
    }

    private emitEmbeddedContent(contentBlocks: unknown, toolCallId: string): void {
        const blocks = Array.isArray(contentBlocks) ? contentBlocks : contentBlocks ? [contentBlocks] : [];
        for (const block of blocks) {
            const content = this.unwrapContent(block);
            if (!content || typeof content !== 'object') {
                continue;
            }

            if ((content as any).type === 'diff') {
                this.emitEvent({
                    type: 'diff',
                    path: (content as any).path,
                    oldText: (content as any).oldText || '',
                    newText: (content as any).newText || '',
                    toolCallId,
                });
                continue;
            }

            if ((content as any).type === 'terminal' && typeof (content as any).terminalId === 'string') {
                const terminalSnapshot = this.getTerminalOutput((content as any).terminalId);
                if (terminalSnapshot.output) {
                    this.emitEvent({
                        type: 'tool_result',
                        tool_result: {
                            toolCallId,
                            result: terminalSnapshot.output,
                            isError: Boolean(terminalSnapshot.exitStatus && terminalSnapshot.exitStatus.exitCode && terminalSnapshot.exitStatus.exitCode !== 0),
                        },
                    });
                }
            }
        }
    }

    private extractToolParams(update: any): Record<string, unknown> {
        if (update?.rawInput && typeof update.rawInput === 'object') {
            return update.rawInput;
        }

        const params: Record<string, unknown> = {};
        if (update?.kind) {
            params.kind = update.kind;
        }
        if (Array.isArray(update?.locations) && update.locations.length > 0) {
            params.locations = update.locations;
        }
        return params;
    }

    private extractContentText(content: unknown): string {
        return this.extractContentTextList(content).join('');
    }

    private extractContentTextList(content: unknown): string[] {
        const blocks = Array.isArray(content) ? content : content ? [content] : [];
        const texts: string[] = [];
        for (const block of blocks) {
            const item = this.unwrapContent(block);
            if (item && typeof item === 'object' && (item as any).type === 'text' && typeof (item as any).text === 'string') {
                texts.push((item as any).text);
            }
        }
        return texts;
    }

    private unwrapContent(block: unknown): any {
        if (!block || typeof block !== 'object') {
            return block;
        }
        if ((block as any).type === 'content' && (block as any).content) {
            return (block as any).content;
        }
        return block;
    }

    private async readTextFile(params: any): Promise<string> {
        const filePath = String(params?.path || '');
        if (!path.isAbsolute(filePath)) {
            throw new Error(`ACP fs/read_text_file requires an absolute path: ${filePath}`);
        }

        const openDoc = vscode.workspace.textDocuments?.find((doc) => doc.uri.fsPath === filePath);
        const fullText = openDoc ? openDoc.getText() : fs.readFileSync(filePath, 'utf-8');
        const line = typeof params?.line === 'number' && params.line > 0 ? params.line - 1 : 0;
        const limit = typeof params?.limit === 'number' && params.limit > 0 ? params.limit : undefined;
        const lines = fullText.split(/\r?\n/);
        const sliced = limit === undefined ? lines.slice(line) : lines.slice(line, line + limit);
        return sliced.join('\n');
    }

    private async writeTextFile(params: any): Promise<void> {
        const filePath = String(params?.path || '');
        const content = String(params?.content ?? '');
        if (!path.isAbsolute(filePath)) {
            throw new Error(`ACP fs/write_text_file requires an absolute path: ${filePath}`);
        }

        const openDoc = vscode.workspace.textDocuments?.find((doc) => doc.uri.fsPath === filePath);
        if (openDoc) {
            const range = new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(openDoc.lineCount, 0),
            );
            const edit = new vscode.WorkspaceEdit();
            edit.replace(openDoc.uri, range, content);
            await vscode.workspace.applyEdit(edit);
            await openDoc.save();
            return;
        }

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
    }

    private async createTerminal(params: any): Promise<string> {
        const command = String(params?.command || '');
        if (!command) {
            throw new Error('ACP terminal/create requires a command');
        }
        const args = Array.isArray(params?.args) ? params.args.map((value: unknown) => String(value)) : [];
        const cwd = typeof params?.cwd === 'string' && path.isAbsolute(params.cwd)
            ? params.cwd
            : this.config.workspaceRoot;
        const envEntries = Array.isArray(params?.env) ? params.env : [];
        const env = { ...process.env } as Record<string, string>;
        for (const entry of envEntries) {
            if (entry && typeof entry.name === 'string') {
                env[entry.name] = typeof entry.value === 'string' ? entry.value : '';
            }
        }

        const terminalId = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const outputByteLimit =
            typeof params?.outputByteLimit === 'number' && params.outputByteLimit > 0
                ? params.outputByteLimit
                : 1024 * 1024;

        let child: child_process.ChildProcess;
        try {
            child = _deps.spawn(command, args, { cwd, env });
        } catch (error) {
            throw wrapSpawnError(error, command);
        }

        const terminal: ManagedTerminal = {
            id: terminalId,
            child,
            output: '',
            truncated: false,
            outputByteLimit,
            exitStatus: null,
            waiters: [],
        };
        this.terminals.set(terminalId, terminal);

        const appendOutput = (chunk: string) => {
            terminal.output += chunk;
            while (Buffer.byteLength(terminal.output) > terminal.outputByteLimit && terminal.output.length > 0) {
                terminal.output = terminal.output.slice(1);
                terminal.truncated = true;
            }
        };

        child.stdout?.on('data', (data: Buffer) => appendOutput(data.toString('utf8')));
        child.stderr?.on('data', (data: Buffer) => appendOutput(data.toString('utf8')));
        child.on('error', (error: Error) => appendOutput(`${error.message}\n`));
        child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
            terminal.exitStatus = { exitCode, signal };
            for (const waiter of terminal.waiters.splice(0)) {
                waiter(terminal.exitStatus);
            }
        });

        return terminalId;
    }

    private getTerminalOutput(terminalId: string): {
        output: string;
        truncated: boolean;
        exitStatus: { exitCode: number | null; signal: NodeJS.Signals | null } | null;
    } {
        const terminal = this.terminals.get(String(terminalId));
        if (!terminal) {
            throw new Error(`Unknown ACP terminal: ${terminalId}`);
        }

        return {
            output: terminal.output,
            truncated: terminal.truncated,
            exitStatus: terminal.exitStatus,
        };
    }

    private waitForTerminalExit(
        terminalId: string,
    ): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
        const terminal = this.terminals.get(String(terminalId));
        if (!terminal) {
            throw new Error(`Unknown ACP terminal: ${terminalId}`);
        }
        if (terminal.exitStatus) {
            return Promise.resolve(terminal.exitStatus);
        }
        return new Promise((resolve) => {
            terminal.waiters.push(resolve);
        });
    }

    private async killTerminal(terminalId: string): Promise<void> {
        const terminal = this.terminals.get(String(terminalId));
        if (!terminal) {
            throw new Error(`Unknown ACP terminal: ${terminalId}`);
        }
        if (!terminal.child.killed && !terminal.exitStatus) {
            terminal.child.kill('SIGTERM');
        }
    }

    private async releaseTerminal(terminalId: string): Promise<void> {
        const terminal = this.terminals.get(String(terminalId));
        if (!terminal) {
            return;
        }
        if (!terminal.child.killed && !terminal.exitStatus) {
            terminal.child.kill('SIGTERM');
        }
        this.terminals.delete(String(terminalId));
    }

    private sendRequest(method: string, params: Record<string, unknown>): Promise<any> {
        const id = ++this.nextRequestId;
        this.writeMessage({ jsonrpc: '2.0', id, method, params });
        return new Promise((resolve, reject) => {
            this.pending.set(id, { method, resolve, reject });
        });
    }

    private sendNotification(method: string, params: Record<string, unknown>): void {
        this.writeMessage({ jsonrpc: '2.0', method, params });
    }

    private writeMessage(message: unknown): void {
        if (this.disposed || !this.child?.stdin) {
            throw new Error('ACP transport is not writable');
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    private respond(id: number, result: unknown): void {
        this.writeMessage({ jsonrpc: '2.0', id, result });
    }

    private respondError(id: number, code: number, message: string): void {
        this.writeMessage({
            jsonrpc: '2.0',
            id,
            error: { code, message },
        });
    }

    private rejectPending(error: Error): void {
        for (const [id, pending] of this.pending.entries()) {
            this.pending.delete(id);
            pending.reject(error);
        }
    }

    private emitEvent(event: unknown): void {
        this.eventCallback?.(event);
    }

    private emitProgress(message: string): void {
        this.progressCallback?.(message);
    }

    private emitError(error: Error): void {
        this.errorCallback?.(error);
    }

    private emitClose(exitCode: number | null): void {
        if (this.closeEmitted) {
            return;
        }
        this.closeEmitted = true;
        this.closeCallback?.(exitCode);
    }
}

export function createTransport(
    config: OpenCodeTransportConfig,
    logger?: TransportLogger,
): OpenCodeTransport {
    switch (config.mode) {
        case 'server':
            return new ServeTransport(config, logger);
        case 'acp':
            return new AcpTransport(config, logger);
        default:
            throw new Error(`Unknown transport mode: ${(config as OpenCodeTransportConfig).mode}`);
    }
}
