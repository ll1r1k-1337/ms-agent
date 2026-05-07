import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OpenCodeFixBackend } from '../../src/backends/openCodeFixBackend';
import { FixtureTransport, loadFixture } from '../helpers/fixtureTransport';
import {
    AddressSpace,
    BlockType,
    MemErrorType,
    SanitizerDiagnostic,
    Severity,
} from '../../src/parser/types';
import { FixCallbacks } from '../../src/backends/fixBackend';

interface IntegrationSetup {
    tempDir: string;
    filePath: string;
    originalContent: string;
    cleanup: () => void;
}

function createWorkspace(fileName: string, originalContent: string): IntegrationSetup {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msagent-it-'));
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, originalContent, 'utf-8');
    return {
        tempDir,
        filePath,
        originalContent,
        cleanup: () => {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        },
    };
}

function makeDiagnostic(filePath: string, line: number): SanitizerDiagnostic {
    return {
        errorType: MemErrorType.OUT_OF_BOUNDS,
        severity: Severity.ERROR,
        fileName: filePath,
        lineNumber: line,
        serialNo: 1,
        address: '0xDEADBEEF',
        addressSpace: AddressSpace.GM,
        byteSize: 4,
        blockInfo: { blockType: BlockType.AICORE, coreId: 0 },
        deviceId: 0,
        rawLines: [],
    };
}

interface CollectingCallbacks extends FixCallbacks {
    events: Array<{ type: string; payload: unknown }>;
    diffs: unknown[];
}

function collectingCallbacks(): CollectingCallbacks {
    const events: Array<{ type: string; payload: unknown }> = [];
    const diffs: unknown[] = [];
    return {
        events,
        diffs,
        onEvent: (type, payload) => {
            events.push({ type, payload });
        },
        onDiff: (filePath, oldText, newText, toolCallId) => {
            diffs.push({ filePath, oldText, newText, toolCallId });
        },
    };
}

function getOriginalAddCustomSource(): string {
    const current = fs.readFileSync(
        path.resolve(__dirname, '..', 'fixtures-src', 'add_custom.cpp'),
        'utf-8',
    );
    return current.replace(
        '        DataCopy(zLocal, xLocal, TILE_LENGTH);',
        '        DataCopy(zLocal, xLocal, 2* TILE_LENGTH);',
    );
}

async function runFixture(
    fixtureName: string,
    originalContent: string,
    options?: { fileName?: string; line?: number },
): Promise<{
    result: Awaited<ReturnType<OpenCodeFixBackend['executeFix']>>;
    diskContent: string;
    workspace: IntegrationSetup;
    callbacks: CollectingCallbacks;
    transport: FixtureTransport;
    transports: FixtureTransport[];
}> {
    return runFixtureSequence([fixtureName], originalContent, options);
}

async function runFixtureSequence(
    fixtureNames: string[],
    originalContent: string,
    options?: { fileName?: string; line?: number },
): Promise<{
    result: Awaited<ReturnType<OpenCodeFixBackend['executeFix']>>;
    diskContent: string;
    workspace: IntegrationSetup;
    callbacks: CollectingCallbacks;
    transport: FixtureTransport;
    transports: FixtureTransport[];
}> {
    const workspace = createWorkspace(options?.fileName || 'kernel.cpp', originalContent);
    const fixtures = fixtureNames.map((fixtureName) => loadFixture(fixtureName));
    const transports: FixtureTransport[] = [];
    let transportIndex = 0;
    const backend = new OpenCodeFixBackend(() => {
        const fixture = fixtures[Math.min(transportIndex, fixtures.length - 1)];
        transportIndex += 1;
        const transport = new FixtureTransport(fixture, workspace.tempDir);
        transports.push(transport);
        return transport;
    });
    const callbacks = collectingCallbacks();
    const diagnostic = makeDiagnostic(workspace.filePath, options?.line || 2);

    const result = await backend.executeFix(
        diagnostic,
        { workspaceRoot: workspace.tempDir },
        callbacks,
    );
    const diskContent = fs.readFileSync(workspace.filePath, 'utf-8');
    return { result, diskContent, workspace, callbacks, transport: transports[0], transports };
}

describe('OpenCodeFixBackend (integration via FixtureTransport)', () => {
    describe('good-oneshot-codeblock', () => {
        it('preserves the original file when the model returns a code block instead of editing with tools', async () => {
            const original = 'int main() { return 0; }\n';
            const run = await runFixture('good-oneshot-codeblock', original);
            try {
                expect(run.result.success).to.equal(false);
                expect(run.result.outcome).to.equal('failed');
                expect(run.result.fileChanged).to.equal(false);
                expect(run.result.finalMessage).to.include('code block');
                expect(run.diskContent).to.equal(original);
                expect(run.callbacks.diffs.length).to.equal(0);
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('placeholder-echo (regression 2026-04-24)', () => {
        it('preserves original file and reports placeholder failure', async () => {
            const original = 'int main() { return 0; }\n';
            const run = await runFixture('placeholder-echo', original);
            try {
                expect(run.result.success).to.equal(false);
                expect(run.result.outcome).to.equal('failed');
                expect(run.result.fileChanged).to.equal(false);
                expect(run.result.finalMessage.toLowerCase()).to.match(/placeholder|truncated/);
                expect(run.diskContent).to.equal(original);
                expect(run.callbacks.diffs.length).to.equal(0);
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('truncated-154-vs-1704 (regression 2026-04-24)', () => {
        it('preserves the original file when a code block is only a partial replacement', async () => {
            const lines = Array.from(
                { length: 50 },
                (_, i) => `int function_${i}() { return ${i} * 2; }`,
            );
            const original = lines.join('\n') + '\n';
            const run = await runFixture('truncated-154-vs-1704', original);
            try {
                expect(run.result.success).to.equal(false);
                expect(run.result.outcome).to.equal('failed');
                expect(run.result.fileChanged).to.equal(false);
                expect(run.result.finalMessage).to.include('code block');
                expect(run.diskContent).to.equal(original);
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('single-line-codeblock-terminal (regression 2026-04-26)', () => {
        it('does not replace the whole file with one C++ statement', async () => {
            const original = [
                '#include "kernel_operator.h"',
                'using namespace AscendC;',
                'extern "C" __global__ __aicore__ void add_custom() {',
                '    DataCopy(zLocal, xLocal, TILE_LENGTH);',
                '}',
                '',
            ].join('\n');
            const run = await runFixture('single-line-codeblock-terminal', original, { fileName: 'add_custom.cpp', line: 4 });
            try {
                expect(run.result.success).to.equal(false);
                expect(run.result.outcome).to.equal('failed');
                expect(run.result.fileChanged).to.equal(false);
                expect(run.result.finalMessage).to.include('code block');
                expect(run.diskContent).to.equal(original);
                expect(run.diskContent).to.include('#include "kernel_operator.h"');
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('cannot-fix-refusal', () => {
        it('reports the model reason and preserves original file', async () => {
            const original = 'int main() { return 0; }\n';
            const run = await runFixture('cannot-fix-refusal', original);
            try {
                expect(run.result.success).to.equal(false);
                expect(run.result.outcome).to.equal('failed');
                expect(run.result.fileChanged).to.equal(false);
                expect(run.result.finalMessage).to.equal(
                    'I cannot safely patch this kernel without the Ascend C runtime headers.',
                );
                expect(run.diskContent).to.equal(original);
                expect(run.callbacks.diffs.length).to.equal(0);
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('no-fix-needed', () => {
        it('returns no_change and preserves the original file', async () => {
            const original = 'int main() { return 0; }\n';
            const run = await runFixture('no-fix-needed', original);
            try {
                expect(run.result.success).to.equal(false);
                expect(run.result.outcome).to.equal('no_change');
                expect(run.result.fileChanged).to.equal(false);
                expect(run.result.finalMessage).to.equal(
                    'The file already uses the bounded length on the affected write path.',
                );
                expect(run.diskContent).to.equal(original);
                expect(run.callbacks.diffs.length).to.equal(0);
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('same-code-no-reason', () => {
        it('fails with the new unexplained no-op fallback', async () => {
            const original = 'int main() { return 0; }\n';
            const run = await runFixture('same-code-no-reason', original);
            try {
                expect(run.result.success).to.equal(false);
                expect(run.result.outcome).to.equal('failed');
                expect(run.result.fileChanged).to.equal(false);
                expect(run.result.finalMessage).to.include(
                    'returned the original code without explaining why',
                );
                expect(run.diskContent).to.equal(original);
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('sse-end-no-terminal (PR 3 preservation invariant)', () => {
        it('preserves the original file when SSE closes without a hard terminal event', async () => {
            // The serve-mode bug class: stream emits a partial code block, then
            // soft-closes (server.disconnect) without ever emitting done /
            // step_end / message.updated:info.time.completed. Under the new
            // contract this MUST NOT overwrite the file with the partial.
            const lines = Array.from(
                { length: 30 },
                (_, i) => `int function_${i}() { return ${i} * 2; }`,
            );
            const original = lines.join('\n') + '\n';

            const run = await runFixture('sse-end-no-terminal', original);
            try {
                expect(run.diskContent).to.equal(original);
                expect(run.result.fileChanged).to.equal(false);
                expect(run.result.outcome).to.equal('failed');
                expect(run.callbacks.diffs.length).to.equal(0);
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('tool-chain-read-edit (PR 2 happy path)', () => {
        it('detects disk mutation from edit tool and reports success without parsing a code block', async () => {
            const original = 'int function_0() { return 0 * 2; }\nint function_1() { return 1 * 2; }\n';
            const expectedAfterEdit =
                'int function_0() { return 0 * 2; }\nint function_1_fixed() { return 1 * 2; }\n';

            const run = await runFixture('tool-chain-read-edit', original);
            try {
                expect(run.result.success).to.equal(true);
                expect(run.result.outcome).to.equal('applied');
                expect(run.result.fileChanged).to.equal(true);
                expect(run.diskContent).to.equal(expectedAfterEdit);
                expect(run.callbacks.diffs.length).to.equal(1);
                expect(run.result.explanationKind).to.equal('synthetic');
                expect(run.result.finalMessage).to.include('Problem:');
                expect(run.result.finalMessage).to.include('Fix:');
                expect(run.result.finalMessage).to.include('Why it works:');
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('read-tool continuation boundaries', () => {
        it('waits through finish=tool-calls after read_file and applies the later edit_file patch', async () => {
            const original = 'int function_0() { return 0 * 2; }\nint function_1() { return 1 * 2; }\n';
            const expectedAfterEdit =
                'int function_0() { return 0 * 2; }\nint function_1_fixed() { return 1 * 2; }\n';

            const run = await runFixture('read-tool-then-edit-continuation', original);
            try {
                expect(run.result.success).to.equal(true);
                expect(run.result.outcome).to.equal('applied');
                expect(run.result.fileChanged).to.equal(true);
                expect(run.diskContent).to.equal(expectedAfterEdit);
                expect(run.callbacks.diffs.length).to.equal(1);
                expect(run.result.explanationKind).to.equal('synthetic');
                expect(run.result.finalMessage).to.include('Problem:');
                expect(run.result.finalMessage).to.include('Fix:');
                expect(run.result.finalMessage).to.include('Why it works:');
            } finally {
                run.workspace.cleanup();
            }
        });

        it('waits through read_file continuation but still rejects a later C++ code block', async () => {
            const original = 'int main() { return 0; }\n';
            const run = await runFixture('read-tool-then-codeblock', original);
            try {
                expect(run.result.success).to.equal(false);
                expect(run.result.outcome).to.equal('failed');
                expect(run.result.fileChanged).to.equal(false);
                expect(run.result.finalMessage).to.include('code block');
                expect(run.diskContent).to.equal(original);
                expect(run.callbacks.diffs.length).to.equal(0);
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('add-custom-minimal-edit', () => {
        it('applies the bounded write fix to add_custom.cpp', async () => {
            const original = getOriginalAddCustomSource();
            const run = await runFixture('add-custom-minimal-edit', original, {
                fileName: 'add_custom.cpp',
                line: 30,
            });
            try {
                expect(run.result.success).to.equal(true);
                expect(run.result.outcome).to.equal('applied');
                expect(run.result.fileChanged).to.equal(true);
                expect(run.result.explanationKind).to.equal('synthetic');
                expect(run.result.finalMessage).to.include('Problem:');
                expect(run.result.finalMessage).to.include('Fix:');
                expect(run.result.finalMessage).to.include('Why it works:');
                expect(run.diskContent).to.not.include('DataCopy(zGlobal[progress], zLocal, TILE_LENGTH);');
                expect(run.diskContent).to.include('DataCopy(zGlobal[progress], zLocal, copyLen);');
                expect(run.callbacks.diffs.length).to.equal(1);
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('no-op retry add_custom line 30', () => {
        it('retries once and applies only the diagnostic DataCopy size fix', async () => {
            const original = getOriginalAddCustomSource();
            const run = await runFixtureSequence(
                ['same-code-no-reason', 'add-custom-line30-tilelength-edit'],
                original,
                { fileName: 'add_custom.cpp', line: 30 },
            );
            try {
                expect(run.transports).to.have.length(2);
                expect(run.result.success).to.equal(true);
                expect(run.result.outcome).to.equal('applied');
                expect(run.result.explanationKind).to.equal('synthetic');
                const sessionEndEvents = run.callbacks.events.filter((event) => event.type === 'session_end');
                expect(sessionEndEvents).to.have.length(1);
                expect((sessionEndEvents[0].payload as any).outcome).to.equal('applied');
                expect((sessionEndEvents[0].payload as any).explanationKind).to.equal('synthetic');
                expect(run.result.finalMessage).to.include('Problem:');
                expect(run.result.finalMessage).to.include('Fix:');
                expect(run.result.finalMessage).to.include('Why it works:');
                expect(run.diskContent).to.include('DataCopy(zLocal, xLocal, TILE_LENGTH);');
                expect(run.diskContent).to.not.include('DataCopy(zLocal, xLocal, 2* TILE_LENGTH);');
                expect(run.diskContent).to.include('DataCopy(zGlobal[progress * 3], zLocal, TILE_LENGTH);');
                expect(run.diskContent).to.include('// Line 50: BUG - reading uninitialized yLocal');

                const originalLines = original.split('\n');
                const newLines = run.diskContent.split('\n');
                const changedLines = originalLines
                    .map((line, index) => ({ index, oldLine: line, newLine: newLines[index] }))
                    .filter((entry) => entry.oldLine !== entry.newLine);
                expect(changedLines).to.deep.equal([{
                    index: 29,
                    oldLine: '        DataCopy(zLocal, xLocal, 2* TILE_LENGTH);',
                    newLine: '        DataCopy(zLocal, xLocal, TILE_LENGTH);',
                }]);
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('successful explanation fallback from session messages', () => {
        it('uses the current session message list when the streamed text never contained the final explanation', async () => {
            const original = getOriginalAddCustomSource();
            const run = await runFixture('add-custom-line30-tilelength-edit-session-explanation', original, {
                fileName: 'add_custom.cpp',
                line: 30,
            });
            try {
                expect(run.result.success).to.equal(true);
                expect(run.result.outcome).to.equal('applied');
                expect(run.result.explanationKind).to.equal('structured');
                expect(run.result.finalMessage).to.include('Problem: the copy length exceeds the local zLocal buffer capacity.');
                expect(run.result.finalMessage).to.not.include('Verifying the target line before editing.');
                expect(run.diskContent).to.include('DataCopy(zLocal, xLocal, TILE_LENGTH);');
                expect(run.callbacks.diffs.length).to.equal(1);
            } finally {
                run.workspace.cleanup();
            }
        });

        it('synthesizes a structured explanation when the successful session transcript contains no final explanation', async () => {
            const original = getOriginalAddCustomSource();
            const run = await runFixture('add-custom-line30-tilelength-edit-no-explanation', original, {
                fileName: 'add_custom.cpp',
                line: 30,
            });
            try {
                expect(run.result.success).to.equal(true);
                expect(run.result.outcome).to.equal('applied');
                expect(run.result.explanationKind).to.equal('synthetic');
                expect(run.result.finalMessage).to.include('Problem:');
                expect(run.result.finalMessage).to.include('Fix:');
                expect(run.result.finalMessage).to.include('Why it works:');
                expect(run.diskContent).to.include('DataCopy(zLocal, xLocal, TILE_LENGTH);');
                expect(run.callbacks.diffs.length).to.equal(1);
            } finally {
                run.workspace.cleanup();
            }
        });

        it('synthesizes a structured explanation when a patch is followed by an aborted assistant message', async () => {
            const original = getOriginalAddCustomSource();
            const run = await runFixture('add-custom-line30-tilelength-edit-no-explanation-aborted', original, {
                fileName: 'add_custom.cpp',
                line: 30,
            });
            try {
                expect(run.result.success).to.equal(true);
                expect(run.result.outcome).to.equal('applied');
                expect(run.result.explanationKind).to.equal('synthetic');
                expect(run.result.finalMessage).to.include('Problem:');
                expect(run.result.finalMessage).to.include('Fix:');
                expect(run.result.finalMessage).to.include('Why it works:');
                expect(run.diskContent).to.include('DataCopy(zLocal, xLocal, TILE_LENGTH);');
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('focused-snippet-echo (regression 2026-04-26)', () => {
        it('preserves original file when model echoes the focused snippet', async () => {
            const original = 'int main() { return 0; }\n';
            const run = await runFixture('focused-snippet-echo', original);
            try {
                expect(run.result.success).to.equal(false);
                expect(run.result.outcome).to.equal('failed');
                expect(run.result.fileChanged).to.equal(false);
                expect(run.result.finalMessage.toLowerCase()).to.match(/placeholder|snippet|truncated/);
                expect(run.diskContent).to.equal(original);
                expect(run.callbacks.diffs.length).to.equal(0);
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('prompt-echo-soft-close (regression 2026-04-26)', () => {
        it('does not treat the echoed user prompt marker as a real NO_FIX_NEEDED decision', async () => {
            const original = 'int main() { return 0; }\n';
            const run = await runFixture('prompt-echo-soft-close', original);
            try {
                expect(run.result.success).to.equal(false);
                expect(run.result.outcome).to.equal('failed');
                expect(run.result.fileChanged).to.equal(false);
                expect(run.result.finalMessage.toLowerCase()).to.include('transport closed before hard terminal event');
                expect(run.diskContent).to.equal(original);
            } finally {
                run.workspace.cleanup();
            }
        });
    });

    describe('wire-tool-edit-terminal (server wire regression 2026-04-26)', () => {
        it('ignores user prompt echo, recognizes tool edit flow, and finalizes on assistant completion', async () => {
            const original = 'int function_0() { return 0 * 2; }\nint function_1() { return 1 * 2; }\n';
            const expectedAfterEdit =
                'int function_0() { return 0 * 2; }\nint function_1_fixed() { return 1 * 2; }\n';

            const run = await runFixture('wire-tool-edit-terminal', original);
            try {
                expect(run.result.success).to.equal(true);
                expect(run.result.outcome).to.equal('applied');
                expect(run.result.fileChanged).to.equal(true);
                expect(run.diskContent).to.equal(expectedAfterEdit);
                expect(run.result.explanationKind).to.equal('synthetic');
                expect(run.result.finalMessage).to.include('Problem:');
                expect(run.result.finalMessage).to.include('Fix:');
                expect(run.result.finalMessage).to.include('Why it works:');
            } finally {
                run.workspace.cleanup();
            }
        });
    });
});
