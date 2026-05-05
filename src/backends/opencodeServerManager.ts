import * as child_process from 'child_process';
import * as http from 'http';

export interface OpenCodeServerManagerConfig {
    cliPath?: string;
    servePort?: number;
    apiKey?: string;
    workspaceRoot?: string;
    timeoutMs: number;
}

export type TransportLogger = (message: string) => void;

interface ManagedServer {
    child?: child_process.ChildProcess;
    readyPromise: Promise<void>;
    ready: boolean;
}

interface ServerManagerDeps {
    spawn: typeof child_process.spawn;
    httpRequest: typeof http.request;
}

const defaultDeps: ServerManagerDeps = {
    spawn: child_process.spawn,
    httpRequest: http.request,
};

const deps: ServerManagerDeps = {
    ...defaultDeps,
};

const managedServers = new Map<string, ManagedServer>();

export function _setServerManagerTestDeps(nextDeps: Partial<ServerManagerDeps>): void {
    Object.assign(deps, nextDeps);
}

export function _resetServerManagerTestDeps(): void {
    deps.spawn = defaultDeps.spawn;
    deps.httpRequest = defaultDeps.httpRequest;
    disposeAllManagedServers();
}

export function disposeAllManagedServers(): void {
    for (const [key, managed] of managedServers.entries()) {
        if (managed.child && !managed.child.killed) {
            managed.child.kill('SIGTERM');
        }
        managedServers.delete(key);
    }
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCliPath(config: OpenCodeServerManagerConfig): string {
    return config.cliPath || 'opencode';
}

function getServerKey(config: OpenCodeServerManagerConfig): string {
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

function probePort(port: number, timeoutMs = 500): Promise<boolean> {
    return new Promise((resolve) => {
        const req = deps.httpRequest(
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
        const req = deps.httpRequest(
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
    config: OpenCodeServerManagerConfig,
    logger?: TransportLogger,
): Promise<ManagedServer> {
    const port = config.servePort;
    if (port === undefined) {
        throw new Error('OpenCode serve port is required');
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
        child = deps.spawn(cliPath, ['serve', '--port', String(port)], {
            timeout: config.timeoutMs,
            cwd: config.workspaceRoot,
            env: {
                ...process.env,
                ...(config.apiKey ? { OPENCODE_API_KEY: config.apiKey } : {}),
            },
        });
    } catch (error) {
        throw wrapSpawnError(error, cliPath);
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

export class OpenCodeServerManager {
    private readonly config: OpenCodeServerManagerConfig;
    private readonly logger?: TransportLogger;

    constructor(config: OpenCodeServerManagerConfig, logger?: TransportLogger) {
        this.config = config;
        this.logger = logger;
    }

    async ensureReady(): Promise<string> {
        const port = this.config.servePort;
        if (port === undefined) {
            throw new Error('OpenCode serve port is required');
        }
        await ensureManagedServer(this.config, this.logger);
        return `http://127.0.0.1:${port}`;
    }
}
