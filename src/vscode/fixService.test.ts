import { expect } from 'chai';
import * as path from 'path';
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
    fixIssue,
    fixIssues,
    cancelBatch,
    showFixDetailsPanel,
    _resetFixState,
    _enqueueFixTask,
    _setActiveFix,
    _setActiveBatchMeta,
    _setPausedFix,
    _setPauseRequested,
    _addFixedIndex,
    _setTestDeps,
    _resetTestDeps,
    _resetFixOutputChannelForTests,
    _recordCompletedTaskForTests,
    _subscribeQueueEventsForTests,
} from './fixService';
import * as backendFactory from '../backends/backendFactory';
import * as configModule from '../llm/config';
import { FixCallbacks, FixContext } from '../backends/fixBackend';
import { WebviewPanelProvider } from '../webview/webviewPanelProvider';
import { SanitizerDiagnostic, MemErrorType, Severity, AddressSpace, BlockType } from '../parser/types';
import { repairIssueFromSanitizerDiagnostic, RepairIssue } from './repairIssue';
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
                issue: repairIssueFromSanitizerDiagnostic(diag),
                resolve: () => {},
            });
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.states['4']).to.equal('queued');
            expect(snapshot.hasPendingTasks).to.be.true;
        });

        it('surfaces batchId on queued items', () => {
            const diag = makeDiag();
            _enqueueFixTask({
                key: 'k1',
                title: 'Batch Task #1',
                diagnostic: diag,
                batchMeta: { batchId: 'batch_test', batchIndex: 0, batchTotal: 2 },
                resolve: () => {},
            });
            _enqueueFixTask({
                key: 'k2',
                title: 'Batch Task #2',
                diagnostic: diag,
                batchMeta: { batchId: 'batch_test', batchIndex: 1, batchTotal: 2 },
                resolve: () => {},
            });
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.items).to.have.length(2);
            expect(snapshot.items[0].batchId).to.equal('batch_test');
            expect(snapshot.items[0].batchIndex).to.equal(0);
            expect(snapshot.items[0].batchTotal).to.equal(2);
            expect(snapshot.items[1].batchIndex).to.equal(1);
        });

        it('reports activeBatchId when the running task is part of a batch', () => {
            _setActiveBatchMeta({ batchId: 'batch_running', batchIndex: 0, batchTotal: 3 });
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.activeBatchId).to.equal('batch_running');
        });

        it('exposes runningTasks for the currently active tasks', () => {
            _setActiveFix(7, 'Active Fix #7');
            _setActiveFix(8, 'Active Fix #8');
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.runningTasks).to.have.length(2);
            const titles = snapshot.runningTasks.map((t) => t.title).sort();
            expect(titles).to.deep.equal(['Active Fix #7', 'Active Fix #8']);
        });

        it('starts with an empty recentlyCompleted list', () => {
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.recentlyCompleted).to.deep.equal([]);
        });

        it('keys caller-owned (no sanitizerIndex) tasks by task id', () => {
            _enqueueFixTask({
                id: 'task_caller_1',
                key: 'k',
                title: 'Caller-owned task',
                diagnostic: makeDiag(),
                resolve: () => {},
            });
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.states['task_caller_1']).to.equal('queued');
        });

        it('surfaces opencodeSessionId on snapshot items once the backend reports it', () => {
            _enqueueFixTask({
                key: 'k-session',
                sanitizerIndex: 0,
                title: 'OUT_OF_BOUNDS - test.cpp:10',
                diagnostic: makeDiag(),
                opencodeSessionId: 'ses_abc123',
                resolve: () => {},
            });
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.items).to.have.length(1);
            expect(snapshot.items[0].opencodeSessionId).to.equal('ses_abc123');
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
            existsSyncStub.withArgs(path.normalize('/workspace/src/test.cpp')).returns(true);
            getLastLogDirStub.returns(undefined);
            const result = resolveFilePath('src/test.cpp', '/workspace');
            expect(result).to.equal(path.normalize('/workspace/src/test.cpp'));
        });

        it('searches lastLogDir when not found in workspace', () => {
            existsSyncStub.withArgs(path.normalize('/workspace/test.cpp')).returns(false);
            existsSyncStub.withArgs(path.normalize('/logs/test.cpp')).returns(true);
            getLastLogDirStub.returns('/logs');
            const result = resolveFilePath('test.cpp', '/workspace');
            expect(result).to.equal(path.normalize('/logs/test.cpp'));
        });

        it('falls back to workspace root when file not found anywhere', () => {
            existsSyncStub.returns(false);
            getLastLogDirStub.returns(undefined);
            const result = resolveFilePath('missing.cpp', '/workspace');
            expect(result).to.equal(path.normalize('/workspace/missing.cpp'));
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

    describe('task_detail posting', () => {
        function stubWebview(): sinon.SinonStub {
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
            (global as any).msAgentContext = {
                extensionUri: { fsPath: '/workspace' },
                subscriptions: [],
            };
            return postMessageStub;
        }

        function stubConfig() {
            sinon.stub(configModule, 'getLLMConfig').returns({
                modelName: 'opencode/minimax-m2.5-free',
                providerID: 'opencode',
                modelID: 'minimax-m2.5-free',
                modelFullName: 'opencode/minimax-m2.5-free',
                timeoutMs: 300000,
                opencodeServePort: 7325,
                opencodeCliPath: 'opencode',
            });
        }

        function findTaskDetail(postMessageStub: sinon.SinonStub): any {
            return postMessageStub.getCalls()
                .map((call) => call.args[0])
                .find((message) => message && message.type === 'task_detail');
        }

        it('posts task_detail carrying the applied diff for a completed fix', async () => {
            const diagnostic = makeDiag({ fileName: '/workspace/test.cpp' });
            const postMessageStub = stubWebview();
            stubConfig();
            sinon.stub(DiagnosticsManager, 'getCurrentDiagnostics').returns([diagnostic]);
            sinon.stub(DiagnosticsManager, 'removeDiagnostic').returns(true);
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
                        finalMessage: 'Fix: clamped the copy length to the buffer size.',
                    });
                    return {
                        success: true,
                        outcome: 'applied',
                        finalMessage: 'Fix: clamped the copy length to the buffer size.',
                        toolCallCount: 1,
                        fileChanged: true,
                        originalContent: 'int n = 8;',
                        newContent: 'int n = 4;',
                    };
                },
            } as any);

            const result = await fixProblem(0, { clearWebview: true });
            expect(result.status).to.equal('completed');

            const taskDetail = findTaskDetail(postMessageStub);
            expect(taskDetail, 'expected a task_detail message').to.not.be.undefined;
            expect(taskDetail.payload.status).to.equal('completed');
            expect(taskDetail.payload.taskId).to.be.a('string');
            expect(taskDetail.payload.taskId.length).to.be.greaterThan(0);
            expect(taskDetail.payload.diffs).to.have.length(1);
            expect(taskDetail.payload.diffs[0].oldText).to.equal('int n = 8;');
            expect(taskDetail.payload.diffs[0].newText).to.equal('int n = 4;');
            expect(taskDetail.payload.finalMessage).to.include('clamped the copy length');
        });

        it('posts task_detail carrying the failure reason for a failed fix', async () => {
            const diagnostic = makeDiag({ fileName: '/workspace/test.cpp' });
            const postMessageStub = stubWebview();
            stubConfig();
            sinon.stub(DiagnosticsManager, 'getCurrentDiagnostics').returns([diagnostic]);
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
                        finalMessage: 'Rate limit exceeded. Please try again later.',
                    });
                    return {
                        success: false,
                        outcome: 'failed',
                        finalMessage: 'Rate limit exceeded. Please try again later.',
                        toolCallCount: 0,
                        fileChanged: false,
                    };
                },
            } as any);

            const result = await fixProblem(0, { clearWebview: true });
            expect(result.status).to.equal('failed');

            const taskDetail = findTaskDetail(postMessageStub);
            expect(taskDetail, 'expected a task_detail message').to.not.be.undefined;
            expect(taskDetail.payload.status).to.equal('failed');
            expect(taskDetail.payload.diffs).to.deep.equal([]);
            expect(taskDetail.payload.finalMessage).to.include('Rate limit exceeded');
        });

        it('runs fixProblem as a batch of one — stamps taskId and carries batch metadata', async () => {
            const diagnostic = makeDiag({ fileName: '/workspace/test.cpp' });
            const postMessageStub = stubWebview();
            stubConfig();
            sinon.stub(DiagnosticsManager, 'getCurrentDiagnostics').returns([diagnostic]);
            sinon.stub(DiagnosticsManager, 'removeDiagnostic').returns(true);
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
                        finalMessage: 'Fix applied.',
                    });
                    return {
                        success: true,
                        outcome: 'applied',
                        finalMessage: 'Fix applied.',
                        toolCallCount: 1,
                        fileChanged: true,
                        originalContent: 'a',
                        newContent: 'b',
                    };
                },
            } as any);

            const result = await fixProblem(0, { clearWebview: true });
            expect(result.status).to.equal('completed');

            // Every run-scoped message is stamped with the queue task id.
            const sessionStart: any = postMessageStub.getCalls()
                .map((call) => call.args[0])
                .find((message) => message && message.type === 'session_start');
            expect(sessionStart, 'expected a session_start message').to.not.be.undefined;
            expect(sessionStart.taskId).to.be.a('string');
            expect(sessionStart.taskId.length).to.be.greaterThan(0);

            // The envelope taskId matches the task_detail task id.
            const taskDetail = findTaskDetail(postMessageStub);
            expect(taskDetail, 'expected a task_detail message').to.not.be.undefined;
            expect(sessionStart.taskId).to.equal(taskDetail.payload.taskId);

            // The single fix carries batch-of-one metadata.
            const completed = getAiFixQueueSnapshot().recentlyCompleted;
            expect(completed).to.have.length(1);
            expect(completed[0].batchId).to.be.a('string');
            expect(completed[0].batchId).to.have.lengthOf.above(0);
            expect(completed[0].batchIndex).to.equal(0);
            expect(completed[0].batchTotal).to.equal(1);
        });
    });

    describe('fixIssue direct payload handling', () => {
        function stubWebview() {
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
            (global as any).msAgentContext = {
                extensionUri: { fsPath: '/workspace' },
                subscriptions: [],
            };
        }

        function stubConfig() {
            sinon.stub(configModule, 'getLLMConfig').returns({
                modelName: 'opencode/minimax-m2.5-free',
                providerID: 'opencode',
                modelID: 'minimax-m2.5-free',
                modelFullName: 'opencode/minimax-m2.5-free',
                timeoutMs: 300000,
                opencodeServePort: 7325,
                opencodeCliPath: 'opencode',
            });
        }

        it('rejects malformed payloads without starting a backend run', async () => {
            const warningStub = sinon.stub(vscode.window, 'showWarningMessage');
            const createBackendStub = sinon.stub(backendFactory, 'createFixBackend');

            const result = await fixIssue({ message: 'missing uri and range' });

            expect(result.status).to.equal('invalid_payload');
            expect(warningStub.calledOnce).to.equal(true);
            expect(String(warningStub.firstCall.args[0])).to.include('invalid fixIssue payload');
            expect(createBackendStub.called).to.equal(false);
        });

        it('normalizes a caller-owned issue payload and runs a one-off fix', async () => {
            stubWebview();
            stubConfig();
            let receivedIssue: RepairIssue | undefined;
            sinon.stub(backendFactory, 'createFixBackend').returns({
                name: 'opencode',
                supportsStreaming: () => true,
                cancel: () => {},
                executeFix: async (
                    issue: RepairIssue,
                    _context: FixContext,
                    callbacks?: FixCallbacks,
                ) => {
                    receivedIssue = issue;
                    callbacks?.onEvent?.('session_start', { backend: 'opencode', mode: 'server' });
                    callbacks?.onEvent?.('session_end', {
                        success: true,
                        outcome: 'applied',
                        finalMessage: 'Problem: external issue\nFix: changed code\nWhy it works: safe.',
                    });
                    return {
                        success: true,
                        outcome: 'applied',
                        finalMessage: 'Problem: external issue\nFix: changed code\nWhy it works: safe.',
                        toolCallCount: 0,
                        fileChanged: true,
                        originalContent: 'before',
                        newContent: 'after',
                    };
                },
            } as any);
            const removeDiagnosticStub = sinon.stub(DiagnosticsManager, 'removeDiagnostic');

            const result = await fixIssue({
                uri: vscode.Uri.file('/workspace/test.cpp'),
                range: new vscode.Range(4, 2, 4, 12),
                issueType: 'OUT_OF_BOUNDS',
                message: 'copy writes past the local buffer',
                severity: vscode.DiagnosticSeverity.Error,
                details: {
                    address: '0x1000',
                    addressSpace: 'GM',
                    byteSize: 4,
                    kernelName: 'ExternalKernel',
                    stack: [{ file: '/workspace/test.cpp', line: 5, column: 3 }],
                },
            });

            expect(result.status).to.equal('completed');
            expect(result.removedDiagnostic).to.equal(false);
            expect(removeDiagnosticStub.called).to.equal(false);
            expect(receivedIssue).to.include({
                fileName: path.normalize('/workspace/test.cpp'),
                lineNumber: 5,
                issueType: 'OUT_OF_BOUNDS',
                errorType: 'OUT_OF_BOUNDS',
                message: 'copy writes past the local buffer',
                address: '0x1000',
                addressSpace: 'GM',
                byteSize: 4,
                kernelName: 'ExternalKernel',
            });
            expect(receivedIssue?.range).to.deep.equal({
                startLine: 5,
                startCharacter: 2,
                endLine: 5,
                endCharacter: 12,
            });
            expect(receivedIssue?.callStack?.[0]).to.deep.equal({
                file: '/workspace/test.cpp',
                line: 5,
                column: 3,
            });
        });
    });

    describe('cancelBatch', () => {
        it('rejects empty or non-string batchIds without touching state', () => {
            const result = cancelBatch('' as string);
            expect(result).to.deep.equal({ cancelled: 0, queued: 0, paused: 0, running: 0 });
        });

        it('removes queued tasks that belong to the batch and resolves them as cancelled', () => {
            const diag = makeDiag();
            const resolved: Array<{ status: string }> = [];
            _enqueueFixTask({
                key: 'k1',
                title: 'Batch Task A',
                diagnostic: diag,
                batchMeta: { batchId: 'batch_cancel', batchIndex: 0, batchTotal: 2 },
                resolve: (r) => resolved.push(r),
            });
            _enqueueFixTask({
                key: 'k2',
                title: 'Batch Task B',
                diagnostic: diag,
                batchMeta: { batchId: 'batch_cancel', batchIndex: 1, batchTotal: 2 },
                resolve: (r) => resolved.push(r),
            });
            _enqueueFixTask({
                key: 'k3',
                title: 'Unrelated',
                diagnostic: diag,
                resolve: () => {},
            });

            const result = cancelBatch('batch_cancel');

            expect(result.cancelled).to.equal(2);
            expect(result.queued).to.equal(2);
            expect(resolved.map((r) => r.status)).to.deep.equal(['cancelled', 'cancelled']);
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.items.map((i) => i.title)).to.deep.equal(['Unrelated']);
        });

        it('cancels paused tasks belonging to the batch', () => {
            const diag = makeDiag();
            const resolved: Array<{ status: string }> = [];
            _setPausedFix({
                id: 'paused_b1',
                key: 'paused-key',
                title: 'Paused In Batch',
                issue: repairIssueFromSanitizerDiagnostic(diag),
                batchMeta: { batchId: 'batch_paused', batchIndex: 0, batchTotal: 1 },
                resolve: (r) => resolved.push(r),
            });
            const result = cancelBatch('batch_paused');
            expect(result.cancelled).to.equal(1);
            expect(result.paused).to.equal(1);
            expect(resolved[0].status).to.equal('cancelled');
        });

        it('returns zero counts when the batchId has no matching tasks', () => {
            const diag = makeDiag();
            _enqueueFixTask({
                key: 'k',
                title: 'task',
                diagnostic: diag,
                batchMeta: { batchId: 'other', batchIndex: 0, batchTotal: 1 },
                resolve: () => {},
            });
            const result = cancelBatch('does_not_exist');
            expect(result).to.deep.equal({ cancelled: 0, queued: 0, paused: 0, running: 0 });
            const snapshot = getAiFixQueueSnapshot();
            expect(snapshot.items).to.have.length(1);
        });
    });

    describe('queueEvents coalescing', () => {
        it('400 sequential enqueues produce exactly one queue_delta with added.length === 400', async () => {
            _resetFixState();
            const sink = sinon.stub();
            const unsubscribe = _subscribeQueueEventsForTests(sink);
            try {
                for (let i = 0; i < 400; i += 1) {
                    _enqueueFixTask({
                        key: 'k:' + i,
                        title: 'T' + i,
                        issue: repairIssueFromSanitizerDiagnostic(makeDiag({ lineNumber: i + 1 })),
                        resolve: () => {},
                    });
                }
                await Promise.resolve();
                await Promise.resolve();
                expect(sink.callCount).to.equal(1);
                const delta = sink.firstCall.args[0];
                expect(delta.added).to.have.lengthOf(400);
            } finally {
                unsubscribe();
            }
        });
    });

    describe('getAiFixQueueSnapshot groups', () => {
        it('stamps group=queued on items, group=running on runningTasks, group=completed on terminal', () => {
            _resetFixState();
            _enqueueFixTask({
                key: 'q:k:OUT',
                title: 'Q',
                issue: repairIssueFromSanitizerDiagnostic(makeDiag()),
                resolve: () => {},
            });
            _setActiveFix(0, 'R');
            _recordCompletedTaskForTests(
                {
                    id: 'done',
                    key: 'c:k:OUT',
                    title: 'D',
                    issue: repairIssueFromSanitizerDiagnostic(makeDiag()),
                    resolve: () => {},
                } as any,
                'completed',
            );

            const snap = getAiFixQueueSnapshot();
            expect(snap.items.map((i) => i.group)).to.deep.equal(['queued']);
            expect((snap.runningTasks ?? []).map((r) => r.group)).to.deep.equal(['running']);
            expect((snap.recentlyCompleted ?? []).map((c) => c.group)).to.deep.equal(['completed']);
        });

        it('maps every CompletedTaskStatus value to the right group', () => {
            _resetFixState();
            const cases: Array<['completed' | 'no_change' | 'failed' | 'cancelled' | 'stopped', 'completed' | 'failed' | 'cancelled']> = [
                ['completed', 'completed'],
                ['no_change', 'completed'],
                ['failed', 'failed'],
                ['cancelled', 'cancelled'],
                ['stopped', 'cancelled'],
            ];
            for (const [status, expectedGroup] of cases) {
                _resetFixState();
                _recordCompletedTaskForTests(
                    {
                        id: `t-${status}`,
                        key: `k:${status}`,
                        title: `T-${status}`,
                        issue: repairIssueFromSanitizerDiagnostic(makeDiag()),
                        resolve: () => {},
                    } as any,
                    status,
                );
                const snap = getAiFixQueueSnapshot();
                const item = (snap.recentlyCompleted ?? []).find((c) => c.id === `t-${status}`);
                expect(item, `recentlyCompleted entry for ${status}`).to.exist;
                expect(item!.group, `group for status=${status}`).to.equal(expectedGroup);
            }
        });
    });

    describe('cancel_task webview action', () => {
        function stubPanelPlumbing() {
            sinon.stub(WebviewPanelProvider.prototype, 'postMessage');
            sinon.stub(WebviewPanelProvider.prototype, 'createOrShow').returns({
                webview: { postMessage: () => Promise.resolve(true) },
                reveal: () => {},
                dispose: () => {},
                onDidDispose: () => {},
            } as any);
            sinon.stub(WebviewPanelProvider.prototype, 'revealLatestSession');
            (global as any).msAgentContext = {
                extensionUri: { fsPath: '/workspace' },
                subscriptions: [],
            };
        }

        // Capture the onAction callback fixService registers in ensureFixDetailsPanel.
        function captureOnAction(): () => ((m: { type?: string; id?: string }) => void) | undefined {
            let captured: ((m: { type?: string; id?: string }) => void) | undefined;
            sinon.stub(WebviewPanelProvider.prototype, 'onAction')
                .callsFake((cb: (m: { type?: string; id?: string }) => void) => {
                    captured = cb;
                });
            return () => captured;
        }

        function makeSpyCts(): { cts: any; cancel: sinon.SinonSpy } {
            const cancel = sinon.spy();
            return {
                cts: { token: { isCancellationRequested: false }, cancel, dispose: () => {} },
                cancel,
            };
        }

        it('cancels one active task without pausing the pipeline', () => {
            stubPanelPlumbing();
            const getHandler = captureOnAction();
            const { cts, cancel } = makeSpyCts();
            const taskId = _setActiveFix(3, 'CANCEL_ME', cts);

            showFixDetailsPanel();
            const handler = getHandler();
            expect(handler, 'onAction callback was registered').to.be.a('function');

            handler!({ type: 'cancel_task', id: taskId });

            expect(cancel.calledOnce).to.be.true;
            // Cancelling one task must not pause the whole queue.
            expect(getAiFixQueueSnapshot().paused).to.be.false;
        });

        it('leaves sibling active tasks running when one is cancelled', () => {
            stubPanelPlumbing();
            const getHandler = captureOnAction();
            const target = makeSpyCts();
            const sibling = makeSpyCts();
            const targetId = _setActiveFix(1, 'TARGET', target.cts);
            _setActiveFix(2, 'SIBLING', sibling.cts);

            showFixDetailsPanel();
            getHandler()!({ type: 'cancel_task', id: targetId });

            expect(target.cancel.calledOnce).to.be.true;
            expect(sibling.cancel.called).to.be.false;
            expect(getAiFixQueueSnapshot().runningTasks).to.have.length(2);
        });
    });

    describe('fixIssues batch handling', () => {
        function stubWebview() {
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
            (global as any).msAgentContext = {
                extensionUri: { fsPath: '/workspace' },
                subscriptions: [],
            };
        }

        function stubConfig() {
            sinon.stub(configModule, 'getLLMConfig').returns({
                modelName: 'opencode/minimax-m2.5-free',
                providerID: 'opencode',
                modelID: 'minimax-m2.5-free',
                modelFullName: 'opencode/minimax-m2.5-free',
                timeoutMs: 300000,
                opencodeServePort: 7325,
                opencodeCliPath: 'opencode',
            });
        }

        function makeValidPayload(
            file: string,
            line: number,
            issueType = 'OUT_OF_BOUNDS',
        ): Record<string, unknown> {
            return {
                uri: `file://${file}`,
                range: {
                    start: { line: line - 1, character: 0 },
                    end: { line: line - 1, character: 10 },
                },
                issueType,
                message: `${issueType} in ${file}:${line}`,
                severity: 'Error',
            };
        }

        function stubAppliedBackend(): sinon.SinonStub {
            return sinon.stub(backendFactory, 'createFixBackend').returns({
                name: 'opencode',
                supportsStreaming: () => true,
                cancel: () => {},
                executeFix: async (
                    _issue: RepairIssue,
                    _context: FixContext,
                    callbacks?: FixCallbacks,
                ) => {
                    callbacks?.onEvent?.('session_start', { backend: 'opencode', mode: 'server' });
                    callbacks?.onEvent?.('session_end', {
                        success: true,
                        outcome: 'applied',
                        finalMessage: 'ok',
                    });
                    return {
                        success: true,
                        outcome: 'applied',
                        finalMessage: 'ok',
                        toolCallCount: 0,
                        fileChanged: true,
                        originalContent: 'before',
                        newContent: 'after',
                    };
                },
            } as any);
        }

        it('clears the webview exactly once for a multi-task batch', async () => {
            stubWebview();
            stubConfig();
            stubAppliedBackend();
            const clearStub = WebviewPanelProvider.prototype.clear as sinon.SinonStub;

            const result = await fixIssues([
                makeValidPayload('/workspace/a.cpp', 10),
                makeValidPayload('/workspace/b.cpp', 20),
            ]);

            expect(result.accepted).to.equal(2);
            expect(clearStub.callCount).to.equal(1);
        });

        it('returns an empty result for an empty array without warnings', async () => {
            const warningStub = sinon.stub(vscode.window, 'showWarningMessage');
            const createBackendStub = sinon.stub(backendFactory, 'createFixBackend');
            const result = await fixIssues([]);
            expect(result.total).to.equal(0);
            expect(result.accepted).to.equal(0);
            expect(result.results).to.deep.equal([]);
            expect(result.batchId).to.match(/^batch_\d+_/);
            expect(warningStub.called).to.equal(false);
            expect(createBackendStub.called).to.equal(false);
        });

        it('returns a warning when the requests argument is not an array', async () => {
            const warningStub = sinon.stub(vscode.window, 'showWarningMessage');
            const result = await fixIssues('not-an-array' as unknown);
            expect(result.total).to.equal(0);
            expect(result.accepted).to.equal(0);
            expect(result.results).to.deep.equal([]);
            expect(warningStub.calledOnce).to.equal(true);
        });

        it('reports invalid_payload entries without stopping the rest of the batch', async () => {
            stubWebview(); stubConfig(); stubAppliedBackend();
            sinon.stub(DiagnosticsManager, 'removeDiagnostic');
            const valid1 = makeValidPayload('/workspace/a.cpp', 10, 'OUT_OF_BOUNDS');
            const invalid = { message: 'missing uri and range' };
            const valid2 = makeValidPayload('/workspace/b.cpp', 20, 'MEM_LEAK');
            const result = await fixIssues([valid1, invalid, valid2]);
            expect(result.total).to.equal(3);
            expect(result.accepted).to.equal(2);
            expect(result.results[0].status).to.equal('completed');
            expect(result.results[1].status).to.equal('invalid_payload');
            expect(result.results[1].error).to.be.a('string');
            expect(result.results[2].status).to.equal('completed');
            expect(result.summary.completed).to.equal(2);
            expect(result.summary.invalid_payload).to.equal(1);
        });

        it('uses the caller-supplied batchId when provided', async () => {
            stubWebview(); stubConfig(); stubAppliedBackend();
            sinon.stub(DiagnosticsManager, 'removeDiagnostic');
            const valid = makeValidPayload('/workspace/c.cpp', 30);
            const result = await fixIssues([valid], { batchId: 'caller_batch_42' });
            expect(result.batchId).to.equal('caller_batch_42');
            expect(result.accepted).to.equal(1);
            expect(result.summary.completed).to.equal(1);
        });

        it('does not dedupe payloads that share a file:line:errorType — every selected row gets queued', async () => {
            stubWebview(); stubConfig(); stubAppliedBackend();
            sinon.stub(DiagnosticsManager, 'removeDiagnostic');
            const a = makeValidPayload('/workspace/dup.cpp', 7, 'ILLEGAL_ADDR_READ');
            const b = makeValidPayload('/workspace/dup.cpp', 7, 'ILLEGAL_ADDR_READ');
            const result = await fixIssues([a, b]);
            expect(result.total).to.equal(2);
            expect(result.accepted).to.equal(2);
            expect(result.results[0].status).to.equal('completed');
            expect(result.results[1].status).to.equal('completed');
            expect(result.summary.completed).to.equal(2);
            expect(result.summary.already_running).to.equal(0);
        });

        it('honors msagent.fixesPerBatch by running up to N fixes concurrently', async () => {
            stubWebview(); stubConfig();
            sinon.stub(DiagnosticsManager, 'removeDiagnostic');
            const getConfigStub = sinon.stub(vscode.workspace, 'getConfiguration');
            getConfigStub.withArgs('msagent').returns({
                get: (key: string, fallback: unknown) => (key === 'fixesPerBatch' ? 3 : fallback),
            } as any);
            let inFlight = 0;
            let peakInFlight = 0;
            const releases: Array<() => void> = [];
            sinon.stub(backendFactory, 'createFixBackend').returns({
                name: 'opencode',
                supportsStreaming: () => true,
                cancel: () => {},
                executeFix: async (
                    _issue: RepairIssue,
                    _context: FixContext,
                    callbacks?: FixCallbacks,
                ) => {
                    inFlight += 1;
                    peakInFlight = Math.max(peakInFlight, inFlight);
                    await new Promise<void>((resolve) => { releases.push(resolve); });
                    inFlight -= 1;
                    callbacks?.onEvent?.('session_start', { backend: 'opencode', mode: 'server' });
                    callbacks?.onEvent?.('session_end', {
                        success: true,
                        outcome: 'applied',
                        finalMessage: 'ok',
                    });
                    return {
                        success: true,
                        outcome: 'applied',
                        finalMessage: 'ok',
                        toolCallCount: 0,
                        fileChanged: true,
                        originalContent: 'before',
                        newContent: 'after',
                    };
                },
            } as any);
            const payloads = [
                makeValidPayload('/workspace/a.cpp', 1, 'OUT_OF_BOUNDS'),
                makeValidPayload('/workspace/b.cpp', 2, 'MEM_LEAK'),
                makeValidPayload('/workspace/c.cpp', 3, 'ILLEGAL_ADDR_READ'),
                makeValidPayload('/workspace/d.cpp', 4, 'ILLEGAL_ADDR_WRITE'),
                makeValidPayload('/workspace/e.cpp', 5, 'UNINITIALIZED_READ'),
            ];
            const resultPromise = fixIssues(payloads);
            for (let attempt = 0; attempt < 20 && releases.length < 3; attempt += 1) {
                await new Promise<void>((r) => setImmediate(r));
            }
            expect(releases.length).to.be.at.least(3, 'expected at least 3 concurrent executeFix calls');
            for (const release of releases.slice()) {
                release();
            }
            for (let attempt = 0; attempt < 50 && releases.length < payloads.length; attempt += 1) {
                await new Promise<void>((r) => setImmediate(r));
                for (const release of releases.slice()) {
                    release();
                }
            }
            const result = await resultPromise;
            expect(peakInFlight).to.equal(3);
            expect(result.summary.completed).to.equal(payloads.length);
        });

        it('reports caller-owned batch completions as fixed in the queue snapshot', async () => {
            stubWebview(); stubConfig(); stubAppliedBackend();
            sinon.stub(DiagnosticsManager, 'removeDiagnostic');
            const result = await fixIssues([
                makeValidPayload('/workspace/a.cpp', 10, 'OUT_OF_BOUNDS'),
                makeValidPayload('/workspace/b.cpp', 20, 'MEM_LEAK'),
            ]);
            expect(result.summary.completed).to.equal(2);
            const snapshot = getAiFixQueueSnapshot();
            const fixedCount = Object.values(snapshot.states).filter((state) => state === 'fixed').length;
            expect(fixedCount).to.equal(2);
        });
    });
});
