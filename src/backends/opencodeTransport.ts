import * as child_process from 'child_process';
import * as http from 'http';
import * as https from 'https';

export interface OpenCodeTransport {
    /** Start the transport with the initial prompt. */
    start(prompt: string): void;
    /** Register callback for incoming events (parsed JSON objects). */
    onEvent(callback: (event: unknown) => void): void;
    /** Register callback for transport errors. */
    onError(callback: (error: Error) => void): void;
    /** Register callback for when transport closes. */
    onClose(callback: (exitCode: number | null) => void): void;
    /** Send data back to the transport (e.g., tool results). */
    send(data: unknown): void;
    /** Cancel / abort the transport. */
    cancel(): void;
    /** Dispose resources. */
    dispose(): void;
}

export interface OpenCodeTransportConfig {
    mode: 'cli' | 'server' | 'api';
    cliPath?: string;
    servePort?: number;
    apiEndpoint?: string;
    apiKey?: string;
    timeoutMs: number;
}

export type TransportLogger = (message: string) => void;

class CliTransport implements OpenCodeTransport {
    private readonly config: OpenCodeTransportConfig;
    private readonly logger?: TransportLogger;
    private child: child_process.ChildProcess | null = null;
    private eventCallback: ((event: unknown) => void) | null = null;
    private errorCallback: ((error: Error) => void) | null = null;
    private closeCallback: ((exitCode: number | null) => void) | null = null;
    private hardTimeoutId: NodeJS.Timeout | null = null;
    private inactivityTimer: NodeJS.Timeout | null = null;
    private lastEventTime = Date.now();
    private hasReceivedAnyEvent = false;
    private disposed = false;

    private readonly INACTIVITY_TIMEOUT_MS = 120000;
    private readonly INACTIVITY_CHECK_INTERVAL_MS = 10000;

    constructor(config: OpenCodeTransportConfig, logger?: TransportLogger) {
        this.config = config;
        this.logger = logger;
    }

    start(prompt: string): void {
        if (this.disposed) {
            this.emitError(new Error('Transport has been disposed'));
            return;
        }

        const cliPath = this.config.cliPath;
        if (!cliPath) {
            this.emitError(new Error('CLI path is required for CLI mode'));
            return;
        }

        try {
            this.child = child_process.spawn(cliPath, ['run', '--format', 'json'], {
                timeout: this.config.timeoutMs,
            });
        } catch (err) {
            this.emitError(this.wrapSpawnError(err, cliPath));
            return;
        }

        this.lastEventTime = Date.now();
        this.hasReceivedAnyEvent = false;

        this.setupStdoutHandler();
        this.setupStderrHandler();
        this.setupProcessHandlers();
        this.setupTimers();

        if (this.child.stdin) {
            this.child.stdin.write(prompt);
            // NOTE: Do NOT end stdin — session may need to send tool results later via send()
        }
    }

    onEvent(callback: (event: unknown) => void): void {
        this.eventCallback = callback;
    }

    onError(callback: (error: Error) => void): void {
        this.errorCallback = callback;
    }

    onClose(callback: (exitCode: number | null) => void): void {
        this.closeCallback = callback;
    }

    send(data: unknown): void {
        if (this.disposed || !this.child || !this.child.stdin) {
            this.emitError(new Error('Cannot send: transport not ready or disposed'));
            return;
        }
        this.child.stdin.write(JSON.stringify(data) + '\n');
    }

    cancel(): void {
        if (this.child && !this.child.killed) {
            this.child.kill('SIGTERM');
        }
        this.clearTimers();
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.cancel();
        if (this.child) {
            this.child.stdout?.removeAllListeners();
            this.child.stderr?.removeAllListeners();
            this.child.removeAllListeners();
            this.child = null;
        }
        this.eventCallback = null;
        this.errorCallback = null;
        this.closeCallback = null;
    }

    private setupStdoutHandler(): void {
        if (!this.child || !this.child.stdout) {
            return;
        }

        this.child.stdout.on('data', (data: Buffer) => {
            const text = data.toString();
            const lines = text.split('\n');
            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }
                try {
                    const event = JSON.parse(line);
                    this.resetSlidingTimeout();
                    this.emitEvent(event);
                } catch {
                    // Ignore malformed JSON lines
                    this.logger?.(`OpenCode transport: failed to parse line: ${line.substring(0, 200)}`);
                }
            }
        });
    }

    private setupStderrHandler(): void {
        if (!this.child || !this.child.stderr) {
            return;
        }

        this.child.stderr.on('data', (data: Buffer) => {
            const text = data.toString().trim();
            if (text) {
                this.logger?.(`OpenCode stderr: ${text.substring(0, 200)}`);
            }
        });
    }

    private setupProcessHandlers(): void {
        if (!this.child) {
            return;
        }

        this.child.on('error', (err: Error) => {
            this.clearTimers();
            this.emitError(this.wrapSpawnError(err, this.config.cliPath || 'unknown'));
        });

        this.child.on('close', (exitCode: number | null) => {
            this.clearTimers();
            this.emitClose(exitCode);
        });
    }

    private setupTimers(): void {
        this.hardTimeoutId = setTimeout(() => {
            this.clearTimers();
            if (this.child && !this.child.killed) {
                this.child.kill('SIGTERM');
            }
            this.emitError(
                new Error(
                    `OpenCode reached hard timeout after ${this.config.timeoutMs / 1000}s. If the model is slow, increase timeoutMs in settings.`,
                ),
            );
        }, this.config.timeoutMs);

        this.inactivityTimer = setInterval(() => {
            const elapsed = Date.now() - this.lastEventTime;
            if (this.hasReceivedAnyEvent && elapsed > this.INACTIVITY_TIMEOUT_MS) {
                this.clearTimers();
                if (this.child && !this.child.killed) {
                    this.child.kill('SIGTERM');
                }
                this.emitError(
                    new Error(
                        `OpenCode stalled: no events for ${this.INACTIVITY_TIMEOUT_MS / 1000}s (last event was ${elapsed / 1000}s ago). The model may be unresponsive or OpenCode is stuck.`,
                    ),
                );
            }
        }, this.INACTIVITY_CHECK_INTERVAL_MS);
    }

    private resetSlidingTimeout(): void {
        this.lastEventTime = Date.now();
        this.hasReceivedAnyEvent = true;
    }

    private clearTimers(): void {
        if (this.hardTimeoutId) {
            clearTimeout(this.hardTimeoutId);
            this.hardTimeoutId = null;
        }
        if (this.inactivityTimer) {
            clearInterval(this.inactivityTimer);
            this.inactivityTimer = null;
        }
    }

    private emitEvent(event: unknown): void {
        this.eventCallback?.(event);
    }

    private emitError(error: Error): void {
        this.errorCallback?.(error);
    }

    private emitClose(exitCode: number | null): void {
        this.closeCallback?.(exitCode);
    }

    private wrapSpawnError(err: unknown, cliPath: string): Error {
        if (err instanceof Error && err.message.includes('ENOENT')) {
            return new Error(
                `OpenCode CLI not found at: ${cliPath}. Please install OpenCode or set correct path in settings.`,
            );
        }
        const message = err instanceof Error ? err.message : String(err);
        return new Error(`Failed to run OpenCode: ${message}`);
    }
}

class ServeTransport implements OpenCodeTransport {
    private readonly config: OpenCodeTransportConfig;
    private readonly logger?: TransportLogger;
    private eventCallback: ((event: unknown) => void) | null = null;
    private errorCallback: ((error: Error) => void) | null = null;
    private closeCallback: ((exitCode: number | null) => void) | null = null;
    private request: http.ClientRequest | null = null;
    private timeoutId: NodeJS.Timeout | null = null;
    private disposed = false;
    private buffer = '';

    constructor(config: OpenCodeTransportConfig, logger?: TransportLogger) {
        this.config = config;
        this.logger = logger;
    }

    start(prompt: string): void {
        if (this.disposed) {
            this.emitError(new Error('Transport has been disposed'));
            return;
        }

        const port = this.config.servePort;
        if (port === undefined) {
            this.emitError(new Error('Server port is required for server mode'));
            return;
        }

        const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
        const postData = JSON.stringify({
            model: 'default',
            messages: [{ role: 'user', content: prompt }],
            stream: true,
        });

        const url = new URL(endpoint);
        const options: http.RequestOptions = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'Accept': 'text/event-stream',
            },
        };

        if (this.config.apiKey) {
            options.headers = {
                ...options.headers,
                Authorization: `Bearer ${this.config.apiKey}`,
            };
        }

        this.request = http.request(options, (res) => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                this.emitError(new Error(`Serve mode returned HTTP ${res.statusCode}`));
                this.emitClose(res.statusCode);
                return;
            }

            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                this.buffer += chunk;
                this.processSSEBuffer();
            });

            res.on('end', () => {
                this.clearTimeout();
                this.emitClose(0);
            });

            res.on('error', (err: Error) => {
                this.clearTimeout();
                const errMsg = (err as any).code || err.message || String(err);
                this.emitError(new Error(`Server mode response error: ${errMsg}`));
                this.emitClose(1);
            });
        });

        this.request.on('error', (err: Error) => {
            this.clearTimeout();
            const errMsg = (err as any).code || err.message || String(err);
            this.emitError(new Error(`Server mode request error: ${errMsg}`));
            this.emitClose(1);
        });

        this.setupTimeout();

        this.request.write(postData);
        this.request.end();
    }

    onEvent(callback: (event: unknown) => void): void {
        this.eventCallback = callback;
    }

    onError(callback: (error: Error) => void): void {
        this.errorCallback = callback;
    }

    onClose(callback: (exitCode: number | null) => void): void {
        this.closeCallback = callback;
    }

    send(): void {
        this.emitError(new Error('Serve mode does not support multi-turn via send'));
    }

    cancel(): void {
        if (this.request) {
            this.request.destroy();
            this.request = null;
        }
        this.clearTimeout();
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.cancel();
        this.eventCallback = null;
        this.errorCallback = null;
        this.closeCallback = null;
    }

    private processSSEBuffer(): void {
        const normalized = this.buffer.replace(/\r\n/g, '\n');
        const chunks = normalized.split('\n\n');
        this.buffer = chunks.pop() ?? '';

        for (const chunk of chunks) {
            const lines = chunk.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') {
                        continue;
                    }
                    try {
                        const event = JSON.parse(data);
                        this.emitEvent(event);
                    } catch {
                        this.logger?.(
                            `OpenCode server transport: failed to parse SSE data: ${data.substring(0, 200)}`,
                        );
                    }
                }
            }
        }
    }

    private setupTimeout(): void {
        this.timeoutId = setTimeout(() => {
            this.cancel();
            this.emitError(
                new Error(
                    `Serve mode reached hard timeout after ${this.config.timeoutMs / 1000}s. If the model is slow, increase timeoutMs in settings.`,
                ),
            );
        }, this.config.timeoutMs);
    }

    private clearTimeout(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }

    private emitEvent(event: unknown): void {
        this.eventCallback?.(event);
    }

    private emitError(error: Error): void {
        this.errorCallback?.(error);
    }

    private emitClose(exitCode: number | null): void {
        this.closeCallback?.(exitCode);
    }
}

class ApiTransport implements OpenCodeTransport {
    private readonly config: OpenCodeTransportConfig;
    private readonly logger?: TransportLogger;
    private eventCallback: ((event: unknown) => void) | null = null;
    private errorCallback: ((error: Error) => void) | null = null;
    private closeCallback: ((exitCode: number | null) => void) | null = null;
    private request: http.ClientRequest | null = null;
    private timeoutId: NodeJS.Timeout | null = null;
    private disposed = false;
    private responseBuffer = '';

    constructor(config: OpenCodeTransportConfig, logger?: TransportLogger) {
        this.config = config;
        this.logger = logger;
    }

    start(prompt: string): void {
        if (this.disposed) {
            this.emitError(new Error('Transport has been disposed'));
            return;
        }

        const endpoint = this.config.apiEndpoint;
        if (!endpoint) {
            this.emitError(new Error('API endpoint is required for API mode'));
            return;
        }

        const postData = JSON.stringify({
            model: 'default',
            messages: [{ role: 'user', content: prompt }],
        });

        const url = new URL(endpoint);
        const isHttps = url.protocol === 'https:';
        const requestModule = isHttps ? https : http;

        const options: http.RequestOptions = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        };

        if (this.config.apiKey) {
            options.headers = {
                ...options.headers,
                Authorization: `Bearer ${this.config.apiKey}`,
            };
        }

        this.request = requestModule.request(options, (res) => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                this.emitError(new Error(`API mode returned HTTP ${res.statusCode}`));
                this.emitClose(res.statusCode);
                return;
            }

            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                this.responseBuffer += chunk;
            });

            res.on('end', () => {
                this.clearTimeout();
                try {
                    const response = JSON.parse(this.responseBuffer);
                    const content = response?.choices?.[0]?.message?.content;
                    if (typeof content === 'string') {
                        this.emitEvent({ text: content });
                    } else {
                        this.emitError(new Error('API response missing expected content field'));
                    }
                } catch {
                    this.emitError(
                        new Error(
                            `Failed to parse API response: ${this.responseBuffer.substring(0, 200)}`,
                        ),
                    );
                }
                this.emitClose(0);
            });

            res.on('error', (err: Error) => {
                this.clearTimeout();
                const errMsg = (err as any).code || err.message || String(err);
                this.emitError(new Error(`API mode response error: ${errMsg}`));
                this.emitClose(1);
            });
        });

        this.request.on('error', (err: Error) => {
            this.clearTimeout();
            const errMsg = (err as any).code || err.message || String(err);
            this.emitError(new Error(`API mode request error: ${errMsg}`));
            this.emitClose(1);
        });

        this.setupTimeout();

        this.request.write(postData);
        this.request.end();
    }

    onEvent(callback: (event: unknown) => void): void {
        this.eventCallback = callback;
    }

    onError(callback: (error: Error) => void): void {
        this.errorCallback = callback;
    }

    onClose(callback: (exitCode: number | null) => void): void {
        this.closeCallback = callback;
    }

    send(): void {
        this.emitError(new Error('API mode does not support multi-turn via send'));
    }

    cancel(): void {
        if (this.request) {
            this.request.destroy();
            this.request = null;
        }
        this.clearTimeout();
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.cancel();
        this.eventCallback = null;
        this.errorCallback = null;
        this.closeCallback = null;
    }

    private setupTimeout(): void {
        this.timeoutId = setTimeout(() => {
            this.cancel();
            this.emitError(
                new Error(
                    `API mode reached hard timeout after ${this.config.timeoutMs / 1000}s. If the model is slow, increase timeoutMs in settings.`,
                ),
            );
        }, this.config.timeoutMs);
    }

    private clearTimeout(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }

    private emitEvent(event: unknown): void {
        this.eventCallback?.(event);
    }

    private emitError(error: Error): void {
        this.errorCallback?.(error);
    }

    private emitClose(exitCode: number | null): void {
        this.closeCallback?.(exitCode);
    }
}

export function createTransport(
    config: OpenCodeTransportConfig,
    logger?: TransportLogger,
): OpenCodeTransport {
    switch (config.mode) {
        case 'cli':
            return new CliTransport(config, logger);
        case 'server':
            return new ServeTransport(config, logger);
        case 'api':
            return new ApiTransport(config, logger);
        default:
            throw new Error(`Unknown transport mode: ${(config as OpenCodeTransportConfig).mode}`);
    }
}
