import { expect } from 'chai';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';

import * as configModule from '../../src/llm/config';
import { parseModelName } from '../../src/llm/configResolver';
import { OpenCodeFixBackend } from '../../src/backends/openCodeFixBackend';
import {
    AddressSpace,
    BlockType,
    MemErrorType,
    SanitizerDiagnostic,
    Severity,
} from '../../src/parser/types';
import { FixCallbacks } from '../../src/backends/fixBackend';

type LocalMode = 'server' | 'acp';

interface LocalHarness {
    model: string;
    cliPath: string;
    servePort: number;
    modeSelection: 'server' | 'acp' | 'both';
}

interface EventCollection extends FixCallbacks {
    eventTypes: string[];
    textChunks: string[];
    toolCalls: string[];
    toolResults: string[];
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value || !value.trim()) {
        throw new Error(`${name} is required for local OpenCode integration tests.`);
    }
    return value.trim();
}

function resolveHarness(): LocalHarness {
    const model = requireEnv('MSAGENT_LOCAL_MODEL');
    const cliPath = (process.env.MSAGENT_LOCAL_OPENCODE_CLI_PATH || 'opencode').trim();
    const servePort = Number(process.env.MSAGENT_LOCAL_OPENCODE_PORT || '7325');
    if (!Number.isFinite(servePort) || servePort <= 0) {
        throw new Error('MSAGENT_LOCAL_OPENCODE_PORT must be a positive integer.');
    }

    const modeSelection = (process.env.MSAGENT_LOCAL_OPENCODE_MODE || 'both').trim().toLowerCase();
    if (!['server', 'acp', 'both'].includes(modeSelection)) {
        throw new Error('MSAGENT_LOCAL_OPENCODE_MODE must be one of: server, acp, both.');
    }

    const probe = childProcess.spawnSync(cliPath, ['--help'], { encoding: 'utf-8' });
    if (probe.error) {
        throw new Error(`OpenCode CLI probe failed for "${cliPath}": ${probe.error.message}`);
    }
    if (probe.status !== 0) {
        throw new Error(
            `OpenCode CLI probe returned exit code ${probe.status}. stderr: ${probe.stderr || '(empty)'}`,
        );
    }

    return {
        model,
        cliPath,
        servePort,
        modeSelection: modeSelection as LocalHarness['modeSelection'],
    };
}

function makeWorkspace(): { tempDir: string; filePath: string; cleanup: () => void } {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msagent-local-opencode-'));
    const fixturePath = path.resolve(__dirname, '..', 'fixtures-src', 'add_custom.cpp');
    const filePath = path.join(tempDir, 'add_custom.cpp');
    fs.copyFileSync(fixturePath, filePath);
    return {
        tempDir,
        filePath,
        cleanup: () => {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        },
    };
}

function makeDiagnostic(filePath: string): SanitizerDiagnostic {
    return {
        errorType: MemErrorType.OUT_OF_BOUNDS,
        severity: Severity.ERROR,
        fileName: filePath,
        lineNumber: 30,
        serialNo: 1,
        address: '0xDEADBEEF',
        addressSpace: AddressSpace.GM,
        byteSize: 224,
        blockInfo: { blockType: BlockType.AICORE, coreId: 0 },
        deviceId: 0,
        kernelName: 'add_custom',
        rawLines: [],
    };
}

function collectEvents(): EventCollection {
    const eventTypes: string[] = [];
    const textChunks: string[] = [];
    const toolCalls: string[] = [];
    const toolResults: string[] = [];
    return {
        eventTypes,
        textChunks,
        toolCalls,
        toolResults,
        onEvent: (type) => {
            eventTypes.push(type);
        },
        onMessageChunk: (chunk) => {
            if (chunk.type === 'text_delta' && chunk.delta) {
                textChunks.push(chunk.delta);
            }
        },
        onToolCall: (name) => {
            toolCalls.push(name);
        },
        onToolResult: (_toolCallId, result) => {
            toolResults.push(result);
        },
    };
}

function modeEnabled(harness: LocalHarness, mode: LocalMode): boolean {
    return harness.modeSelection === 'both' || harness.modeSelection === mode;
}

async function runLocalFix(harness: LocalHarness, mode: LocalMode) {
    const workspace = makeWorkspace();
    const backend = new OpenCodeFixBackend();
    const callbacks = collectEvents();
    const diagnostic = makeDiagnostic(workspace.filePath);
    const originalContent = fs.readFileSync(workspace.filePath, 'utf-8');
    const parsedModel = parseModelName(harness.model);

    const configStub = sinon.stub(configModule, 'getLLMConfig').returns({
        modelName: parsedModel.modelName,
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
        modelFullName: parsedModel.modelFullName,
        modelWarning: parsedModel.modelWarning,
        timeoutMs: 300000,
        opencodeMode: mode,
        opencodeServePort: harness.servePort,
        opencodeCliPath: harness.cliPath,
        opencodeAcpArgs: ['acp'],
        opencodeApiKey: process.env.MSAGENT_LOCAL_OPENCODE_API_KEY || '',
    });

    try {
        const result = await backend.executeFix(
            diagnostic,
            { workspaceRoot: workspace.tempDir },
            callbacks,
        );
        const diskContent = fs.readFileSync(workspace.filePath, 'utf-8');
        return { result, callbacks, diskContent, originalContent, workspace };
    } finally {
        configStub.restore();
    }
}

describe('OpenCode local integration', function () {
    this.timeout(600000);

    let harness: LocalHarness;

    before(() => {
        harness = resolveHarness();
    });

    (function registerModeTests() {
        it(modeEnabledPlaceholder('server'), async function () {
            if (!modeEnabled(harness, 'server')) {
                this.skip();
            }

            const run = await runLocalFix(harness, 'server');
            try {
                expect(run.callbacks.eventTypes).to.include('session_start');
                expect(
                    run.callbacks.textChunks.length > 0
                    || run.callbacks.toolCalls.length > 0
                    || run.callbacks.toolResults.length > 0,
                ).to.equal(true);
                expect(run.result.success).to.equal(true);
                expect(run.result.outcome).to.equal('applied');
                expect(run.diskContent).to.not.equal(run.originalContent);
                expect(run.diskContent).to.not.include('DataCopy(zGlobal[progress], zLocal, TILE_LENGTH);');
            } finally {
                run.workspace.cleanup();
            }
        });

        it(modeEnabledPlaceholder('acp'), async function () {
            if (!modeEnabled(harness, 'acp')) {
                this.skip();
            }

            const run = await runLocalFix(harness, 'acp');
            try {
                expect(run.callbacks.eventTypes).to.include('session_start');
                expect(
                    run.callbacks.textChunks.length > 0
                    || run.callbacks.toolCalls.length > 0
                    || run.callbacks.toolResults.length > 0,
                ).to.equal(true);
                if (!run.result.success) {
                    expect(run.result.outcome === 'no_change' || run.result.outcome === 'failed').to.equal(true);
                    expect(run.result.finalMessage.trim().length > 0).to.equal(true);
                    expect(run.result.finalMessage).to.not.include('did not provide a parseable reason');
                    expect(run.result.finalMessage).to.not.include('returned the original code without explaining why');
                } else {
                    expect(run.result.outcome).to.equal('applied');
                }
            } finally {
                run.workspace.cleanup();
            }
        });
    }());
});

function modeEnabledPlaceholder(mode: LocalMode): string {
    return `runs a real ${mode} repair against local opencode`;
}
