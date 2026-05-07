import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    activate,
    deactivate,
    selectOpenCodeModel,
    openMsAgentSettings,
    resolveLogInputToFsPath,
    parseProblemIndex,
    _setTestDeps,
    _resetTestDeps,
} from './extension';
import { DiagnosticsManager } from './vscode/diagnosticsManager';

const g = global as unknown as Record<string, unknown>;
const gt = globalThis as unknown as Record<string, unknown>;

describe('extension', () => {
    let existsSyncStub: sinon.SinonStub;
    let statSyncStub: sinon.SinonStub;
    let registerCommandStub: sinon.SinonStub;
    let activateDiagnosticsStub: sinon.SinonStub;

    beforeEach(() => {
        existsSyncStub = sinon.stub();
        statSyncStub = sinon.stub();
        registerCommandStub = sinon.stub(vscode.commands, 'registerCommand').returns({ dispose: sinon.stub() });
        activateDiagnosticsStub = sinon.stub(DiagnosticsManager, 'activate');

        _setTestDeps({
            existsSync: existsSyncStub,
            statSync: statSyncStub,
        });
    });

    afterEach(() => {
        sinon.restore();
        _resetTestDeps();
        delete g.msAgentContext;
        delete g.msAgentOutputChannel;
        delete gt.__msAgentGetAiFixQueueSnapshot;
        delete gt.__msAgentGetAiFixQueueStates;
        delete (vscode.workspace as any).workspaceFolders;
    });

    function makeContext(): vscode.ExtensionContext {
        return {
            subscriptions: [],
            globalState: {
                keys: () => [],
                get: () => undefined,
                update: sinon.stub().resolves(),
                setKeysForSync: () => {},
            },
            workspaceState: {
                keys: () => [],
                get: () => undefined,
                update: () => Promise.resolve(),
                setKeysForSync: () => {},
            },
            extensionPath: '/ext',
            extensionUri: vscode.Uri.file('/ext'),
            environmentVariableCollection: {} as any,
            storagePath: '/storage',
            globalStoragePath: '/globalStorage',
            logPath: '/log',
            asAbsolutePath: (p: string) => p,
            storageUri: vscode.Uri.file('/storage'),
            globalStorageUri: vscode.Uri.file('/globalStorage'),
            logUri: vscode.Uri.file('/log'),
            extensionMode: 1,
            extension: {} as any,
            secrets: {
                keys: () => Promise.resolve([]),
                onDidChange: () => ({ dispose: () => {} }),
                get: () => Promise.resolve(''),
                store: () => Promise.resolve(),
                delete: () => Promise.resolve(),
            },
            languageModelAccessInformation: {
                onDidChange: () => ({ dispose: () => {} }),
                canSendRequest: undefined,
            } as any,
        } as unknown as vscode.ExtensionContext;
    }

    describe('activate', () => {
        it('registers the OpenCode-only command surface', async () => {
            await activate(makeContext());

            const commands = registerCommandStub.getCalls().map((call) => call.args[0]);
            expect(commands).to.include('msagent.parseLog');
            expect(commands).to.include('msagent.fixProblem');
            expect(commands).to.include('msagent.fixAll');
            expect(commands).to.include('msagent.selectModel');
            expect(commands).to.include('msagent.openSettings');
            expect(commands).to.include('msagent.clearDiagnostics');
            expect(commands).to.not.include('msagent.fixDiagnostic');
            expect(commands).to.not.include('msagent.testWebview');
            expect(activateDiagnosticsStub.calledOnce).to.be.true;
        });

        it('syncs the initial model from OpenCode config when no explicit model is configured', async () => {
            const updateStub = sinon.stub().resolves();
            sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: (key: string) => key === 'modelName' ? 'opencode/minimax-m2.5-free' : undefined,
                inspect: () => ({
                    key: 'msagent.modelName',
                    defaultValue: 'opencode/minimax-m2.5-free',
                }),
                update: updateStub,
            } as any);
            _setTestDeps({
                loadOpenCodeModelCatalog: () => [
                    { id: 'volcengine-plan/doubao-seed-2.0-code', source: 'user', sourcePath: '/Users/test/.config/opencode/opencode.json' },
                    { id: 'opencode/minimax-m2.5-free', source: 'built-in' },
                ],
            });

            await activate(makeContext());

            expect(updateStub.calledOnceWith(
                'modelName',
                'volcengine-plan/doubao-seed-2.0-code',
                vscode.ConfigurationTarget.Global,
            )).to.equal(true);
        });

        it('does not overwrite an explicit user-selected model on activate', async () => {
            const updateStub = sinon.stub().resolves();
            sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: (key: string) => key === 'modelName' ? 'volcengine-plan/doubao-seed-2.0-code' : undefined,
                inspect: () => ({
                    key: 'msagent.modelName',
                    defaultValue: 'opencode/minimax-m2.5-free',
                    globalValue: 'volcengine-plan/doubao-seed-2.0-code',
                }),
                update: updateStub,
            } as any);
            _setTestDeps({
                loadOpenCodeModelCatalog: () => [
                    { id: 'volcengine-plan/doubao-seed-2.0-code', source: 'user', sourcePath: '/Users/test/.config/opencode/opencode.json' },
                    { id: 'opencode/minimax-m2.5-free', source: 'built-in' },
                ],
            });

            await activate(makeContext());

            expect(updateStub.called).to.equal(false);
        });

        it('replaces the legacy gpt-5-nano default with the first configured OpenCode model', async () => {
            const updateStub = sinon.stub().resolves();
            sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: (key: string) => key === 'modelName' ? 'opencode/gpt-5-nano' : undefined,
                inspect: () => ({
                    key: 'msagent.modelName',
                    defaultValue: 'opencode/minimax-m2.5-free',
                    globalValue: 'opencode/gpt-5-nano',
                }),
                update: updateStub,
            } as any);
            _setTestDeps({
                loadOpenCodeModelCatalog: () => [
                    { id: 'moonshot/kimi-k2.6', source: 'user', sourcePath: '/Users/test/.config/opencode/opencode.json' },
                    { id: 'opencode/minimax-m2.5-free', source: 'built-in' },
                ],
            });

            await activate(makeContext());

            expect(updateStub.calledOnceWith(
                'modelName',
                'moonshot/kimi-k2.6',
                vscode.ConfigurationTarget.Global,
            )).to.equal(true);
        });

        it('replaces the legacy default model with the new default when no config model is found', async () => {
            const updateStub = sinon.stub().resolves();
            sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: (key: string) => key === 'modelName' ? 'opencode/big-pickle' : undefined,
                inspect: () => ({
                    key: 'msagent.modelName',
                    defaultValue: 'opencode/minimax-m2.5-free',
                    globalValue: 'opencode/big-pickle',
                }),
                update: updateStub,
            } as any);
            _setTestDeps({
                loadOpenCodeModelCatalog: () => [
                    { id: 'opencode/minimax-m2.5-free', source: 'built-in' },
                    { id: 'opencode/gpt-5-nano', source: 'built-in' },
                ],
            });

            await activate(makeContext());

            expect(updateStub.calledOnceWith(
                'modelName',
                'opencode/minimax-m2.5-free',
                vscode.ConfigurationTarget.Global,
            )).to.equal(true);
        });
    });

    describe('openMsAgentSettings', () => {
        it('opens VS Code settings filtered to msagent', async () => {
            const executeCommandStub = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);

            await openMsAgentSettings();

            expect(executeCommandStub.calledOnceWith('workbench.action.openSettings', 'msagent')).to.equal(true);
        });
    });

    describe('selectOpenCodeModel', () => {
        it('writes the selected model to workspace settings', async () => {
            const updateStub = sinon.stub().resolves();
            const getConfigurationStub = sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: (key: string) => key === 'modelName' ? 'opencode/minimax-m2.5-free' : undefined,
                update: updateStub,
            } as any);
            const showQuickPickStub = sinon.stub(vscode.window, 'showQuickPick').callsFake(async (items: any) => {
                return items.find((item: any) => item.label === 'volcengine-plan/doubao-seed-2.0-code');
            });
            sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined as any);
            const workspace = vscode.workspace as any;
            workspace.workspaceFolders = [{ uri: vscode.Uri.file('/workspace') }];
            _setTestDeps({
                loadOpenCodeModelCatalog: () => [
                    { id: 'opencode/minimax-m2.5-free', source: 'built-in' },
                    { id: 'volcengine-plan/doubao-seed-2.0-code', source: 'workspace', sourcePath: '/workspace/opencode.json' },
                ],
            });

            const selected = await selectOpenCodeModel();

            expect(selected).to.equal('volcengine-plan/doubao-seed-2.0-code');
            expect(showQuickPickStub.calledOnce).to.equal(true);
            expect(getConfigurationStub.calledWith('msagent')).to.equal(true);
            expect(updateStub.calledOnceWith(
                'modelName',
                'volcengine-plan/doubao-seed-2.0-code',
                vscode.ConfigurationTarget.Workspace,
            )).to.equal(true);
            delete workspace.workspaceFolders;
        });
    });

    describe('resolveLogInputToFsPath', () => {
        it('returns fsPath for vscode.Uri input', () => {
            const uri = vscode.Uri.file('/absolute/path.log');
            expect(resolveLogInputToFsPath(uri)).to.equal('/absolute/path.log');
        });

        it('returns fsPath for absolute string input', () => {
            expect(resolveLogInputToFsPath('/absolute/path.log')).to.equal('/absolute/path.log');
        });

        it('returns undefined for empty input', () => {
            expect(resolveLogInputToFsPath(undefined)).to.be.undefined;
            expect(resolveLogInputToFsPath('   ')).to.be.undefined;
        });

        it('resolves relative paths against the first workspace folder', () => {
            const ws = vscode.workspace as unknown as Record<string, unknown>;
            ws.workspaceFolders = [{ uri: vscode.Uri.file('/workspace') }];
            expect(resolveLogInputToFsPath('relative/path.log')).to.equal('/workspace/relative/path.log');
            delete ws.workspaceFolders;
        });
    });

    describe('parseProblemIndex', () => {
        it('accepts non-negative integers', () => {
            expect(parseProblemIndex(5)).to.equal(5);
            expect(parseProblemIndex('3')).to.equal(3);
        });

        it('rejects invalid values', () => {
            expect(parseProblemIndex(undefined)).to.be.null;
            expect(parseProblemIndex('abc')).to.be.null;
            expect(parseProblemIndex(-1)).to.be.null;
            expect(parseProblemIndex(1.5)).to.be.null;
        });
    });

    describe('deactivate', () => {
        it('clears exported globals without throwing', async () => {
            await activate(makeContext());
            expect(() => deactivate()).to.not.throw();
        });
    });
});
