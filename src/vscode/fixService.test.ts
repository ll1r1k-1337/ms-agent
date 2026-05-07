import { expect } from 'chai';
import * as sinon from 'sinon';
import { DiagnosticsManager } from './diagnosticsManager';
import {
    getAiFixQueueSnapshot,
    getAiFixQueueStates,
    resetAiFixHistory,
    resolveFilePath,
    getDiagnosticFixKey,
    getDiagnosticTitle,
    fixProblem,
    _resetFixState,
    _enqueueFixTask,
    _setActiveFix,
    _setPausedFix,
    _setPauseRequested,
    _addFixedIndex,
    _setTestDeps,
    _resetTestDeps,
    _resetFixOutputChannelForTests,
} from './fixService';
import * as backendFactory from '../backends/backendFactory';
import * as configModule from '../llm/config';
import { FixCallbacks, FixContext } from '../backends/fixBackend';
import { WebviewPanelProvider } from '../webview/webviewPanelProvider';
import { SanitizerDiagnostic, MemErrorType, Severity, AddressSpace, BlockType } from '../parser/types';
const vscode = require('vscode');

describe('fixService', () => {
    let existsSyncStub: sinon.SinonStub;
    let getLastLogDirStub: sinon.SinonStub;

    beforeEach(() => {
        existsSyncStub = sinon.stub();
        _setTestDeps({ existsSync: existsSyncStub });
        getLastLogDirStub = sinon.stub(DiagnosticsManager, 'getLastLogDir');
        _resetFixState();
        _resetFixOutputChannelForTests();
    });

    afterEach(() => {
        sinon.restore();
        _resetTestDeps();
        _resetFixState();
        delete (global as any).msAgentContext;
    });

    function makeDiag(overrides: Partial<SanitizerDiagnostic> = {}): SanitizerDiagnostic {
        return {
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
            ...overrides,
        };
    }

    describe('getAiFixQueueSnapshot', () => {
        it('returns empty snapshot when nothing is queued', () => {
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.paused).to.be.false;
            expect(snapshot.hasPendingTasks).to.be.false;
            expect(snapshot.items).to.have.length(0);
            expect(Object.keys(snapshot.states)).to.have.length(0);
        });

        it('shows queued items', () => {
            const diag = makeDiag();
            _enqueueFixTask({
                key: 'test.cpp:10:OUT_OF_BOUNDS',
                sanitizerIndex: 0,
                title: 'OUT_OF_BOUNDS - test.cpp:10',
                diagnostic: diag,
                resolve: () => {},
            });
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.hasPendingTasks).to.be.true;
            expect(snapshot.items).to.have.length(1);
            expect(snapshot.items[0].title).to.equal('OUT_OF_BOUNDS - test.cpp:10');
            expect(snapshot.states['0']).to.equal('queued');
        });

        it('shows active running fix', () => {
            _setActiveFix(2, 'ACTIVE_FIX');
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.states['2']).to.equal('running');
            expect(snapshot.hasPendingTasks).to.be.true;
        });

        it('shows paused state', () => {
            _setPauseRequested(true);
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.paused).to.be.true;
        });

        it('shows fixed indices', () => {
            _addFixedIndex(5);
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.states['5']).to.equal('fixed');
        });

        it('running takes priority over fixed for same index', () => {
            _addFixedIndex(1);
            _setActiveFix(1);
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.states['1']).to.equal('running');
        });

        it('queued takes priority over fixed for same index', () => {
            const diag = makeDiag();
            _addFixedIndex(3);
            _enqueueFixTask({
                key: 'k',
                sanitizerIndex: 3,
                title: 't',
                diagnostic: diag,
                resolve: () => {},
            });
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.states['3']).to.equal('queued');
        });

        it('shows paused active task as queued', () => {
            const diag = makeDiag();
            _setPausedFix({
                id: 'paused_1',
                key: 'k',
                sanitizerIndex: 4,
                title: 'Paused Task',
                diagnostic: diag,
                resolve: () => {},
            });
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.states['4']).to.equal('queued');
            expect(snapshot.hasPendingTasks).to.be.true;
        });
    });

    describe('getAiFixQueueStates', () => {
        it('returns states from snapshot', () => {
            _addFixedIndex(7);
            const states = getAiFixQueueStates();
            expect(states['7']).to.equal('fixed');
        });
    });

    describe('resetAiFixHistory', () => {
        it('clears fixed indices', () => {
            _addFixedIndex(0);
            _addFixedIndex(1);
            expect(Object.keys(getAiFixQueueSnapshot().states)).to.have.length(2);

            resetAiFixHistory();
            const snapshot = getAiFixQueueSnapshot();
            expect(Object.keys(snapshot.states)).to.have.length(0);
        });
    });

    describe('resolveFilePath', () => {
        it('returns absolute path when it exists', () => {
            existsSyncStub.withArgs('/abs/path.cpp').returns(true);
            const result = resolveFilePath('/abs/path.cpp', '/workspace');
            expect(result).to.equal('/abs/path.cpp');
        });

        it('searches workspace root for relative path', () => {
            existsSyncStub.withArgs('/workspace/src/test.cpp').returns(true);
            getLastLogDirStub.returns(undefined);
            const result = resolveFilePath('src/test.cpp', '/workspace');
            expect(result).to.equal('/workspace/src/test.cpp');
        });

        it('searches lastLogDir when not found in workspace', () => {
            existsSyncStub.withArgs('/workspace/test.cpp').returns(false);
            existsSyncStub.withArgs('/logs/test.cpp').returns(true);
            getLastLogDirStub.returns('/logs');
            const result = resolveFilePath('test.cpp', '/workspace');
            expect(result).to.equal('/logs/test.cpp');
        });

        it('falls back to workspace root when file not found anywhere', () => {
            existsSyncStub.returns(false);
            getLastLogDirStub.returns(undefined);
            const result = resolveFilePath('missing.cpp', '/workspace');
            expect(result).to.equal('/workspace/missing.cpp');
        });
    });

    describe('getDiagnosticFixKey', () => {
        it('generates correct key format', () => {
            const diag = makeDiag({ fileName: 'kernel.cpp', lineNumber: 42, errorType: MemErrorType.MEM_LEAK });
            const key = getDiagnosticFixKey(diag);
            expect(key).to.equal('kernel.cpp:42:MEM_LEAK');
        });
    });

    describe('getDiagnosticTitle', () => {
        it('generates correct title format', () => {
            const diag = makeDiag({ fileName: '/path/to/kernel.cpp', lineNumber: 99, errorType: MemErrorType.ILLEGAL_ADDR_READ });
            const title = getDiagnosticTitle(diag);
            expect(title).to.equal('ILLEGAL_ADDR_READ - kernel.cpp:99');
        });
    });

    describe('fixProblem no_change handling', () => {
        it('returns no_change without emitting final_diff or generic error notifications', async () => {
            const diagnostic = makeDiag({ fileName: '/workspace/test.cpp' });
            const postMessageStub = sinon.stub(WebviewPanelProvider.prototype, 'postMessage');
            sinon.stub(WebviewPanelProvider.prototype, 'createOrShow').returns({
                webview: { postMessage: () => Promise.resolve(true) },
                reveal: () => {},
                dispose: () => {},
                onDidDispose: () => {},
            } as any);
            sinon.stub(WebviewPanelProvider.prototype, 'clear');
            sinon.stub(WebviewPanelProvider.prototype, 'onAction');
            sinon.stub(WebviewPanelProvider.prototype, 'nextMessageId').callsFake(() => `msg_${Date.now()}`);

            sinon.stub(DiagnosticsManager, 'getCurrentDiagnostics').returns([diagnostic]);
            sinon.stub(configModule, 'getLLMConfig').returns({
                modelName: 'opencode/minimax-m2.5-free',
                providerID: 'opencode',
                modelID: 'minimax-m2.5-free',
                modelFullName: 'opencode/minimax-m2.5-free',
                timeoutMs: 300000,
                opencodeServePort: 7325,
                opencodeCliPath: 'opencode',
            });
            sinon.stub(backendFactory, 'createFixBackend').returns({
                name: 'opencode',
                supportsStreaming: () => true,
                cancel: () => {},
                executeFix: async (
                    _diag: SanitizerDiagnostic,
                    _context: FixContext,
                    callbacks?: FixCallbacks,
                ) => {
                    callbacks?.onEvent?.('session_start', { backend: 'opencode', mode: 'server' });
                    callbacks?.onEvent?.('session_end', {
                        success: false,
                        outcome: 'no_change',
                        finalMessage: 'The file already uses the bounded length on the affected write path.',
                    });
                    return {
                        success: false,
                        outcome: 'no_change',
                        finalMessage: 'The file already uses the bounded length on the affected write path.',
                        toolCallCount: 0,
                        fileChanged: false,
                    };
                },
            } as any);

            const showErrorMessageStub = sinon.stub(vscode.window, 'showErrorMessage');
            (global as any).msAgentContext = {
                extensionUri: { fsPath: '/workspace' },
                subscriptions: [],
            };

            const result = await fixProblem(0, { clearWebview: true });

            expect(result.status).to.equal('no_change');
            expect(
                postMessageStub.calledWithMatch({ type: 'final_diff' }),
            ).to.equal(false);
            expect(showErrorMessageStub.called).to.equal(false);
        });

        it('logs failed session_end reasons to the msAgent output channel', async () => {
            const diagnostic = makeDiag({ fileName: '/workspace/test.cpp' });
            const appendLineStub = sinon.stub();
            (global as any).msAgentOutputChannel = { appendLine: appendLineStub };
            sinon.stub(WebviewPanelProvider.prototype, 'postMessage');
            sinon.stub(WebviewPanelProvider.prototype, 'createOrShow').returns({
                webview: { postMessage: () => Promise.resolve(true) },
                reveal: () => {},
                dispose: () => {},
                onDidDispose: () => {},
            } as any);
            sinon.stub(WebviewPanelProvider.prototype, 'clear');
            sinon.stub(WebviewPanelProvider.prototype, 'onAction');
            sinon.stub(WebviewPanelProvider.prototype, 'nextMessageId').callsFake(() => `msg_${Date.now()}`);

            sinon.stub(DiagnosticsManager, 'getCurrentDiagnostics').returns([diagnostic]);
            sinon.stub(configModule, 'getLLMConfig').returns({
                modelName: 'opencode/minimax-m2.5-free',
                providerID: 'opencode',
                modelID: 'minimax-m2.5-free',
                modelFullName: 'opencode/minimax-m2.5-free',
                timeoutMs: 300000,
                opencodeServePort: 4096,
                opencodeCliPath: 'opencode',
            });
            sinon.stub(backendFactory, 'createFixBackend').returns({
                name: 'opencode',
                supportsStreaming: () => true,
                cancel: () => {},
                executeFix: async (
                    _diag: SanitizerDiagnostic,
                    _context: FixContext,
                    callbacks?: FixCallbacks,
                ) => {
                    callbacks?.onEvent?.('session_start', { backend: 'opencode', mode: 'server' });
                    callbacks?.onEvent?.('session_end', {
                        success: false,
                        outcome: 'failed',
                        finalMessage: 'Missing API key.',
                    });
                    return {
                        success: false,
                        outcome: 'failed',
                        finalMessage: 'Missing API key.',
                        toolCallCount: 0,
                        fileChanged: false,
                    };
                },
            } as any);

            (global as any).msAgentContext = {
                extensionUri: { fsPath: '/workspace' },
                subscriptions: [],
            };

            const result = await fixProblem(0, { clearWebview: true });

            expect(result.status).to.equal('failed');
            expect(
                appendLineStub.getCalls().some((call) =>
                    String(call.args[0]).includes('[FIX] session_end outcome=failed')
                    && String(call.args[0]).includes('Missing API key.')),
            ).to.equal(true);
        });
    });

    describe('fixProblem completed handling', () => {
        it('removes only the fixed diagnostic after a successful file edit', async () => {
            const diagnostic = makeDiag({ fileName: '/workspace/test.cpp' });
            sinon.stub(WebviewPanelProvider.prototype, 'postMessage');
            sinon.stub(WebviewPanelProvider.prototype, 'createOrShow').returns({
                webview: { postMessage: () => Promise.resolve(true) },
                reveal: () => {},
                dispose: () => {},
                onDidDispose: () => {},
            } as any);
            sinon.stub(WebviewPanelProvider.prototype, 'clear');
            sinon.stub(WebviewPanelProvider.prototype, 'onAction');
            sinon.stub(WebviewPanelProvider.prototype, 'nextMessageId').callsFake(() => `msg_${Date.now()}`);

            sinon.stub(DiagnosticsManager, 'getCurrentDiagnostics').returns([diagnostic]);
            const removeDiagnosticStub = sinon.stub(DiagnosticsManager, 'removeDiagnostic').returns(true);
            sinon.stub(configModule, 'getLLMConfig').returns({
                modelName: 'opencode/minimax-m2.5-free',
                providerID: 'opencode',
                modelID: 'minimax-m2.5-free',
                modelFullName: 'opencode/minimax-m2.5-free',
                timeoutMs: 300000,
                opencodeServePort: 7325,
                opencodeCliPath: 'opencode',
            });
            sinon.stub(backendFactory, 'createFixBackend').returns({
                name: 'opencode',
                supportsStreaming: () => true,
                cancel: () => {},
                executeFix: async (
                    _diag: SanitizerDiagnostic,
                    _context: FixContext,
                    callbacks?: FixCallbacks,
                ) => {
                    callbacks?.onEvent?.('session_start', { backend: 'opencode', mode: 'server' });
                    callbacks?.onEvent?.('session_end', {
                        success: true,
                        outcome: 'applied',
                        finalMessage: 'Problem: buffer size mismatch\nFix: changed length\nWhy it works: writes now fit.',
                    });
                    return {
                        success: true,
                        outcome: 'applied',
                        finalMessage: 'Problem: buffer size mismatch\nFix: changed length\nWhy it works: writes now fit.',
                        toolCallCount: 0,
                        fileChanged: true,
                        originalContent: 'before',
                        newContent: 'after',
                    };
                },
            } as any);

            (global as any).msAgentContext = {
                extensionUri: { fsPath: '/workspace' },
                subscriptions: [],
            };

            const result = await fixProblem(0, { clearWebview: true });

            expect(result.status).to.equal('completed');
            expect(result.removedDiagnostic).to.equal(true);
            expect(removeDiagnosticStub.calledOnce).to.equal(true);
            expect(removeDiagnosticStub.firstCall.args[0]).to.deep.equal(diagnostic);
        });

        it('keeps other diagnostics highlighted when one issue is fixed', async () => {
            const diagnostic1 = makeDiag({ fileName: '/workspace/test.cpp', lineNumber: 10, errorType: MemErrorType.OUT_OF_BOUNDS });
            const diagnostic2 = makeDiag({ fileName: '/workspace/test.cpp', lineNumber: 20, errorType: MemErrorType.MEM_LEAK });
            sinon.stub(WebviewPanelProvider.prototype, 'postMessage');
            sinon.stub(WebviewPanelProvider.prototype, 'createOrShow').returns({
                webview: { postMessage: () => Promise.resolve(true) },
                reveal: () => {},
                dispose: () => {},
                onDidDispose: () => {},
            } as any);
            sinon.stub(WebviewPanelProvider.prototype, 'clear');
            sinon.stub(WebviewPanelProvider.prototype, 'onAction');
            sinon.stub(WebviewPanelProvider.prototype, 'nextMessageId').callsFake(() => `msg_${Date.now()}`);

            sinon.stub(DiagnosticsManager, 'getCurrentDiagnostics').returns([diagnostic1, diagnostic2]);
            const removeDiagnosticStub = sinon.stub(DiagnosticsManager, 'removeDiagnostic').returns(true);
            sinon.stub(configModule, 'getLLMConfig').returns({
                modelName: 'opencode/minimax-m2.5-free',
                providerID: 'opencode',
                modelID: 'minimax-m2.5-free',
                modelFullName: 'opencode/minimax-m2.5-free',
                timeoutMs: 300000,
                opencodeServePort: 7325,
                opencodeCliPath: 'opencode',
            });
            sinon.stub(backendFactory, 'createFixBackend').returns({
                name: 'opencode',
                supportsStreaming: () => true,
                cancel: () => {},
                executeFix: async (
                    _diag: SanitizerDiagnostic,
                    _context: FixContext,
                    callbacks?: FixCallbacks,
                ) => {
                    callbacks?.onEvent?.('session_start', { backend: 'opencode', mode: 'server' });
                    callbacks?.onEvent?.('session_end', {
                        success: true,
                        outcome: 'applied',
                        finalMessage: 'Fixed only the selected issue.',
                    });
                    return {
                        success: true,
                        outcome: 'applied',
                        finalMessage: 'Fixed only the selected issue.',
                        toolCallCount: 0,
                        fileChanged: true,
                        originalContent: 'before',
                        newContent: 'after',
                    };
                },
            } as any);

            (global as any).msAgentContext = {
                extensionUri: { fsPath: '/workspace' },
                subscriptions: [],
            };

            const result = await fixProblem(0, { clearWebview: true });

            expect(result.status).to.equal('completed');
            expect(removeDiagnosticStub.calledOnceWithExactly(diagnostic1)).to.equal(true);
        });
    });
});
