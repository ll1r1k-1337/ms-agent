import * as child_process from 'child_process';

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
    mode: 'cli' | 'serve' | 'api';
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
    private errorCallback: ((error: Error) => void) | null = null;
    private closeCallback: ((exitCode: number | null) => void) | null = null;

    constructor(config: OpenCodeTransportConfig) {
        this.config = config;
    }

    start(): void {
        this.errorCallback?.(new Error('Serve mode not yet implemented'));
    }

    onEvent(): void {
        // no-op
    }

    onError(callback: (error: Error) => void): void {
        this.errorCallback = callback;
    }

    onClose(callback: (exitCode: number | null) => void): void {
        this.closeCallback = callback;
    }

    send(): void {
        // no-op
    }

    cancel(): void {
        this.closeCallback?.(null);
    }

    dispose(): void {
        this.errorCallback = null;
        this.closeCallback = null;
    }
}

class ApiTransport implements OpenCodeTransport {
    private readonly config: OpenCodeTransportConfig;
    private errorCallback: ((error: Error) => void) | null = null;
    private closeCallback: ((exitCode: number | null) => void) | null = null;

    constructor(config: OpenCodeTransportConfig) {
        this.config = config;
    }

    start(): void {
        this.errorCallback?.(new Error('API mode not yet implemented'));
    }

    onEvent(): void {
        // no-op
    }

    onError(callback: (error: Error) => void): void {
        this.errorCallback = callback;
    }

    onClose(callback: (exitCode: number | null) => void): void {
        this.closeCallback = callback;
    }

    send(): void {
        // no-op
    }

    cancel(): void {
        this.closeCallback?.(null);
    }

    dispose(): void {
        this.errorCallback = null;
        this.closeCallback = null;
    }
}

export function createTransport(
    config: OpenCodeTransportConfig,
    logger?: TransportLogger,
): OpenCodeTransport {
    switch (config.mode) {
        case 'cli':
            return new CliTransport(config, logger);
        case 'serve':
            return new ServeTransport(config);
        case 'api':
            return new ApiTransport(config);
        default:
            throw new Error(`Unknown transport mode: ${(config as OpenCodeTransportConfig).mode}`);
    }
}
