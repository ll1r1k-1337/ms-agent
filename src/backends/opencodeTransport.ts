import {
    _resetSdkClientTestFactory,
    _setSdkClientTestFactory,
} from './opencodeSdkClient';
import {
    disposeAllManagedServers,
    _resetServerManagerTestDeps,
    _setServerManagerTestDeps,
    TransportLogger,
} from './opencodeServerManager';
import {
    OpenCodeTurnRunner,
    OpenCodeTurnRunnerConfig,
} from './opencodeTurnRunner';

export interface OpenCodeTransport {
    start(prompt: string): void;
    onEvent(callback: (event: unknown) => void): void;
    onProgress(callback: (message: string) => void): void;
    onError(callback: (error: Error) => void): void;
    onClose(callback: (exitCode: number | null) => void): void;
    readSessionMessages(): Promise<unknown[] | null>;
    cancel(): void;
    dispose(): void;
}

export interface OpenCodeTransportConfig extends OpenCodeTurnRunnerConfig {}
export type { TransportLogger };

export function _setTestDeps(
    deps: Partial<{
        spawn: typeof import('child_process').spawn;
        httpRequest: typeof import('http').request;
        createSdkClient: (config: Record<string, unknown>) => unknown;
    }>,
): void {
    const { spawn, httpRequest, createSdkClient } = deps;
    _setServerManagerTestDeps({
        ...(spawn ? { spawn } : {}),
        ...(httpRequest ? { httpRequest } : {}),
    });
    if (createSdkClient) {
        _setSdkClientTestFactory(createSdkClient as any);
    }
}

export function _resetTestDeps(): void {
    _resetServerManagerTestDeps();
    _resetSdkClientTestFactory();
}

export { disposeAllManagedServers };

class SdkServerTransport implements OpenCodeTransport {
    private readonly config: OpenCodeTransportConfig;
    private readonly logger?: TransportLogger;
    private eventCallback: ((event: unknown) => void) | null = null;
    private progressCallback: ((message: string) => void) | null = null;
    private errorCallback: ((error: Error) => void) | null = null;
    private closeCallback: ((exitCode: number | null) => void) | null = null;
    private runner: OpenCodeTurnRunner;

    constructor(config: OpenCodeTransportConfig, logger?: TransportLogger) {
        this.config = config;
        this.logger = logger;
        this.runner = this.createRunner();
    }

    start(prompt: string): void {
        this.runner.start(prompt);
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

    readSessionMessages(): Promise<unknown[] | null> {
        return this.runner.readSessionMessages();
    }

    cancel(): void {
        this.runner.cancel();
    }

    dispose(): void {
        this.runner.dispose();
    }

    private createRunner(): OpenCodeTurnRunner {
        return new OpenCodeTurnRunner(
            this.config,
            {
                onEvent: (event) => this.eventCallback?.(event),
                onProgress: (message) => this.progressCallback?.(message),
                onError: (error) => this.errorCallback?.(error),
                onClose: (exitCode) => this.closeCallback?.(exitCode),
            },
            this.logger,
        );
    }
}

export function createTransport(
    config: OpenCodeTransportConfig,
    logger?: TransportLogger,
): OpenCodeTransport {
    return new SdkServerTransport(config, logger);
}
