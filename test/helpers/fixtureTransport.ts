import * as fs from 'fs';
import * as path from 'path';
import { OpenCodeTransport } from '../../src/backends/opencodeTransport';

export type FixtureStep =
    | { kind: 'event'; event: unknown; delayMs?: number }
    | { kind: 'progress'; message: string; delayMs?: number }
    | { kind: 'error'; message: string; delayMs?: number }
    | { kind: 'close'; exitCode?: number | null; delayMs?: number }
    | { kind: 'fsWrite'; relPath: string; content: string; delayMs?: number };

export interface LlmScenarioFixture {
    description: string;
    steps: FixtureStep[];
}

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'llm-scenarios');

export function loadFixture(name: string): LlmScenarioFixture {
    const filePath = path.join(FIXTURE_DIR, `${name}.json`);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as LlmScenarioFixture;
    if (!parsed || !Array.isArray(parsed.steps)) {
        throw new Error(`Fixture ${name} is malformed: missing steps[]`);
    }
    return parsed;
}

export class FixtureTransport implements OpenCodeTransport {
    private readonly fixture: LlmScenarioFixture;
    private readonly workspaceRoot: string | undefined;
    private eventCb: ((event: unknown) => void) | null = null;
    private progressCb: ((message: string) => void) | null = null;
    private errorCb: ((error: Error) => void) | null = null;
    private closeCb: ((exitCode: number | null) => void) | null = null;
    private started = false;
    private cancelled = false;
    private disposed = false;

    readonly sent: unknown[] = [];
    readonly prompts: string[] = [];

    constructor(fixture: LlmScenarioFixture, workspaceRoot?: string) {
        this.fixture = fixture;
        this.workspaceRoot = workspaceRoot;
    }

    start(prompt: string): void {
        if (this.disposed || this.started) {
            return;
        }
        this.started = true;
        this.prompts.push(prompt);
        void this.replay();
    }

    onEvent(callback: (event: unknown) => void): void {
        this.eventCb = callback;
    }

    onProgress(callback: (message: string) => void): void {
        this.progressCb = callback;
    }

    onError(callback: (error: Error) => void): void {
        this.errorCb = callback;
    }

    onClose(callback: (exitCode: number | null) => void): void {
        this.closeCb = callback;
    }

    send(data: unknown): void {
        this.sent.push(data);
    }

    cancel(): void {
        this.cancelled = true;
    }

    dispose(): void {
        this.disposed = true;
        this.cancelled = true;
        this.eventCb = null;
        this.progressCb = null;
        this.errorCb = null;
        this.closeCb = null;
    }

    private async replay(): Promise<void> {
        let sawExplicitClose = false;
        for (const step of this.fixture.steps) {
            if (this.cancelled || this.disposed) {
                return;
            }
            if (step.delayMs && step.delayMs > 0) {
                await wait(step.delayMs);
                if (this.cancelled || this.disposed) {
                    return;
                }
            }
            switch (step.kind) {
                case 'event':
                    this.eventCb?.(step.event);
                    break;
                case 'progress':
                    this.progressCb?.(step.message);
                    break;
                case 'error':
                    this.errorCb?.(new Error(step.message));
                    break;
                case 'close':
                    sawExplicitClose = true;
                    this.closeCb?.(step.exitCode ?? 0);
                    break;
                case 'fsWrite': {
                    if (!this.workspaceRoot) {
                        throw new Error(
                            'FixtureTransport.fsWrite step requires workspaceRoot to be passed to the constructor',
                        );
                    }
                    const target = path.join(this.workspaceRoot, step.relPath);
                    fs.writeFileSync(target, step.content, 'utf-8');
                    break;
                }
            }
        }
        if (!sawExplicitClose && !this.cancelled && !this.disposed) {
            // Default close so the session can finalize even if the fixture
            // author forgot to emit an explicit close step.
            this.closeCb?.(0);
        }
    }
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
