import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import * as configModule from '../llm/config';
import * as opencodeTransportModule from './opencodeTransport';
import * as opencodeSessionModule from './opencodeSession';

import { OpenCodeFixBackend } from './openCodeFixBackend';
import { FixContext } from './fixBackend';
import { SanitizerDiagnostic, MemErrorType, Severity, AddressSpace, BlockType } from '../parser/types';

describe('OpenCodeFixBackend', () => {
    let backend: OpenCodeFixBackend;
    let tempDir: string;

    let getLLMConfigStub: sinon.SinonStub;
    let createTransportStub: sinon.SinonStub;
    let openCodeSessionStub: sinon.SinonStub;

    const mockTransport: any = {
        dispose: sinon.stub(),
    };

    const mockSessionRun = sinon.stub();
    const mockSessionCancel = sinon.stub();

    const baseDiagnostic: SanitizerDiagnostic = {
        errorType: MemErrorType.OUT_OF_BOUNDS,
        severity: Severity.ERROR,
        fileName: 'test.cpp',
        lineNumber: 10,
        serialNo: 1,
        address: '0x1000',
        addressSpace: AddressSpace.GM,
        byteSize: 4,
        blockInfo: { blockType: BlockType.AICORE, coreId: 0 },
        deviceId: 0,
        kernelName: 'TestKernel',
        rawLines: ['ERROR: OUT_OF_BOUNDS'],
    };

    const mockConfig = {
        modelName: 'volcengine-plan/doubao-seed-2.0-code',
        providerID: 'volcengine-plan',
        modelID: 'doubao-seed-2.0-code',
        modelFullName: 'volcengine-plan/doubao-seed-2.0-code',
        modelWarning: undefined,
        timeoutMs: 300000,
        opencodeCliPath: '/usr/bin/opencode',
        opencodeServePort: 7325,
        opencodeApiKey: 'test-api-key',
    };

    const mockSessionResult = {
        success: true,
        outcome: 'applied' as const,
        finalMessage: 'Fix applied successfully using OpenCode.',
        toolCallCount: 0,
        fileChanged: true,
        originalContent: 'int main() { return 0; }',
        newContent: 'int main() { return 1; }',
    };

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msagent-test-'));
        backend = new OpenCodeFixBackend();

        getLLMConfigStub = sinon.stub(configModule, 'getLLMConfig').returns(mockConfig);
        createTransportStub = sinon.stub(opencodeTransportModule, 'createTransport').returns(mockTransport);
        openCodeSessionStub = sinon.stub(opencodeSessionModule, 'OpenCodeSession').callsFake(function () {
            return {
                run: mockSessionRun,
                cancel: mockSessionCancel,
            };
        });

        mockTransport.dispose.resetHistory();
        mockSessionRun.reset();
        mockSessionCancel.reset();
    });

    afterEach(() => {
        sinon.restore();
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('reports missing target files', async () => {
        const context: FixContext = { workspaceRoot: tempDir };
        const result = await backend.executeFix(
            { ...baseDiagnostic, fileName: 'missing.cpp' },
            context,
        );

        expect(result.success).to.equal(false);
        expect(result.outcome).to.equal('failed');
        expect(result.finalMessage).to.include('File not found');
    });

    it('creates a server transport with the OpenCode-only config', async () => {
        const testFilePath = path.join(tempDir, 'test.cpp');
        fs.writeFileSync(testFilePath, 'original file content', 'utf-8');
        mockSessionRun.resolves(mockSessionResult);

        await backend.executeFix(
            { ...baseDiagnostic, fileName: 'test.cpp' },
            { workspaceRoot: tempDir },
        );

        expect(createTransportStub.calledOnce).to.be.true;
        expect(createTransportStub.firstCall.args[0]).to.deep.equal({
            cliPath: '/usr/bin/opencode',
            servePort: 7325,
            apiKey: 'test-api-key',
            timeoutMs: 300000,
            model: 'doubao-seed-2.0-code',
            providerID: 'volcengine-plan',
            modelFullName: 'volcengine-plan/doubao-seed-2.0-code',
            workspaceRoot: tempDir,
        });
    });

    it('disposes the transport only after session.run settles', async () => {
        const testFilePath = path.join(tempDir, 'test.cpp');
        fs.writeFileSync(testFilePath, 'original file content', 'utf-8');
        mockSessionRun.callsFake(async () => {
            expect(mockTransport.dispose.called).to.equal(false);
            return mockSessionResult;
        });

        const result = await backend.executeFix(
            { ...baseDiagnostic, fileName: 'test.cpp' },
            { workspaceRoot: tempDir },
        );

        expect(result).to.deep.equal(mockSessionResult);
        expect(mockTransport.dispose.calledOnce).to.equal(true);
    });

    it('forwards cancellation to the active OpenCode session', async () => {
        const testFilePath = path.join(tempDir, 'test.cpp');
        fs.writeFileSync(testFilePath, 'content', 'utf-8');
        mockSessionRun.callsFake(async () => {
            backend.cancel();
            return mockSessionResult;
        });

        await backend.executeFix(
            { ...baseDiagnostic, fileName: 'test.cpp' },
            { workspaceRoot: tempDir },
        );

        expect(mockSessionCancel.called).to.equal(true);
    });

    it('builds a prompt with focused snippet and explicit no-op terminal markers', async () => {
        const testFilePath = path.join(tempDir, 'test.cpp');
        fs.writeFileSync(testFilePath, 'line 1\nline 2\nline 3\n', 'utf-8');
        mockSessionRun.resolves(mockSessionResult);

        await backend.executeFix(
            { ...baseDiagnostic, fileName: 'test.cpp', lineNumber: 2 },
            { workspaceRoot: tempDir },
        );

        const prompt = mockSessionRun.firstCall.args[0].prompt as string;
        expect(prompt).to.include('## Focused Snippet');
        expect(prompt).to.include('NO_FIX_NEEDED: <short reason>');
        expect(prompt).to.include('CANNOT_FIX: <short reason>');
        expect(prompt).to.include('Problem: <why the diagnostic happened>');
        expect(prompt).to.include('Fix: <the exact code change you made>');
        expect(prompt).to.include('Why it works: <why the new bound / edit is safe>');
        expect(prompt).to.include('Do NOT describe a plan, verification steps, or what you are about to do before editing.');
        expect(prompt).to.include('Your first assistant response must be a native tool action');
        expect(prompt).to.include('Emit process narration such as "I\'ll inspect the file"');
        expect(prompt).to.include('>    2 | line 2');
    });

    it('adds a targeted DataCopy hint for OUT_OF_BOUNDS diagnostics', async () => {
        const testFilePath = path.join(tempDir, 'test.cpp');
        fs.writeFileSync(
            testFilePath,
            'void kernel() {\n        DataCopy(zLocal, xLocal, 2* TILE_LENGTH);\n        DataCopy(other, src, TILE_LENGTH);\n}\n',
            'utf-8',
        );
        mockSessionRun.resolves(mockSessionResult);

        await backend.executeFix(
            { ...baseDiagnostic, fileName: 'test.cpp', lineNumber: 2 },
            { workspaceRoot: tempDir },
        );

        const prompt = mockSessionRun.firstCall.args[0].prompt as string;
        expect(prompt).to.include('## Targeted Repair Hint');
        expect(prompt).to.include('DataCopy(zLocal, xLocal, 2* TILE_LENGTH);');
        expect(prompt).to.include('must not be copied with 2 * TILE_LENGTH');
        expect(prompt).to.include('Fix other BUG comments or nearby sanitizer issues that are not the diagnostic at line 2');
    });

    it('retries once when OpenCode finishes without a native edit', async () => {
        const testFilePath = path.join(tempDir, 'test.cpp');
        fs.writeFileSync(testFilePath, 'original file content', 'utf-8');
        const noEditResult = {
            success: false,
            outcome: 'failed' as const,
            finalMessage: 'OpenCode finished without a native edit; original file preserved for safety because it did not provide a parseable reason.',
            toolCallCount: 0,
            fileChanged: false,
        };
        mockSessionRun.onFirstCall().resolves(noEditResult);
        mockSessionRun.onSecondCall().resolves(mockSessionResult);
        const events: Array<{ type: string; payload: unknown }> = [];

        const result = await backend.executeFix(
            { ...baseDiagnostic, fileName: 'test.cpp' },
            { workspaceRoot: tempDir },
            { onEvent: (type, payload) => events.push({ type, payload }) },
        );

        expect(result).to.deep.equal(mockSessionResult);
        expect(mockSessionRun.calledTwice).to.equal(true);
        expect(createTransportStub.calledTwice).to.equal(true);
        expect(mockTransport.dispose.calledTwice).to.equal(true);
        const retryPrompt = mockSessionRun.secondCall.args[0].prompt as string;
        expect(retryPrompt).to.include('## Retry Instruction');
        expect(retryPrompt).to.include('You MUST use OpenCode');
        expect(retryPrompt).to.include('Problem:');
        expect(retryPrompt).to.include('Why it works:');
        expect(retryPrompt).to.include('Your first assistant response MUST be the native edit action or a terminal marker');
        expect(retryPrompt).to.include('Do NOT emit process narration like "I will verify the patch"');
        expect(events.some((event) =>
            event.type === 'status'
            && String((event.payload as any).message).includes('retrying once'),
        )).to.equal(true);
    });

    it('does not retry quota or usage-limit failures', async () => {
        const testFilePath = path.join(tempDir, 'test.cpp');
        fs.writeFileSync(testFilePath, 'original file content', 'utf-8');
        const quotaResult = {
            success: false,
            outcome: 'failed' as const,
            finalMessage: 'You have reached your usage limit for this billing cycle.',
            toolCallCount: 0,
            fileChanged: false,
        };
        mockSessionRun.resolves(quotaResult);

        const result = await backend.executeFix(
            { ...baseDiagnostic, fileName: 'test.cpp' },
            { workspaceRoot: tempDir },
        );

        expect(result).to.deep.equal(quotaResult);
        expect(mockSessionRun.calledOnce).to.equal(true);
        expect(createTransportStub.calledOnce).to.equal(true);
        expect(mockTransport.dispose.calledOnce).to.equal(true);
    });
});
