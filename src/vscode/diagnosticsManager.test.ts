import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as logParser from '../parser/logParser';
import {
    DiagnosticsManager,
    _setTestDeps,
    _resetTestDeps,
    _getDiagnosticCollectionForTest,
} from './diagnosticsManager';

describe('DiagnosticsManager', () => {
    let existsSyncStub: sinon.SinonStub;
    let readdirSyncStub: sinon.SinonStub;
    let readFileSyncStub: sinon.SinonStub;
    let parseLogStub: sinon.SinonStub;

    beforeEach(() => {
        existsSyncStub = sinon.stub();
        readdirSyncStub = sinon.stub();
        readFileSyncStub = sinon.stub();
        parseLogStub = sinon.stub(logParser, 'parseLog');

        _setTestDeps({
            existsSync: existsSyncStub as any,
            readdirSync: readdirSyncStub as any,
            readFileSync: readFileSyncStub as any,
        });

        DiagnosticsManager.activate({
            subscriptions: [],
        } as unknown as vscode.ExtensionContext);
    });

    afterEach(() => {
        sinon.restore();
        _resetTestDeps();
        DiagnosticsManager.clearDiagnostics();
    });

    function makeDiag(overrides: Partial<any> = {}): any {
        return {
            fileName: '/workspace/test.cpp',
            lineNumber: 10,
            errorType: 'OUT_OF_BOUNDS',
            severity: 'Error',
            address: '0x1000',
            addressSpace: 'GM',
            byteSize: 4,
            callStack: [],
            ...overrides,
        };
    }

    it('stores diagnostics and returns copies of the parsed rows', () => {
        const diag = makeDiag();
        parseLogStub.returns({ diagnostics: [diag] });
        existsSyncStub.returns(true);
        readFileSyncStub.returns('line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\n    broken_call();\n');

        DiagnosticsManager.parseAndPublish('log content');

        const current = DiagnosticsManager.getCurrentDiagnostics();
        expect(current).to.have.length(1);
        current.pop();
        expect(DiagnosticsManager.getCurrentDiagnostics()).to.have.length(1);
    });

    it('starts the range at the first non-whitespace character when no column exists', () => {
        const diag = makeDiag();
        parseLogStub.returns({ diagnostics: [diag] });
        existsSyncStub.returns(true);
        readFileSyncStub.returns('line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\n    broken_call();\n');

        DiagnosticsManager.parseAndPublish('log content');

        const collection = _getDiagnosticCollectionForTest() as any;
        const published = collection.get(vscode.Uri.file('/workspace/test.cpp'));
        expect(published[0].range.start.character).to.equal(4);
    });

    it('publishes precise ranges and msAgentIndex metadata', () => {
        const diag = makeDiag({
            callStack: [{ file: '/workspace/test.cpp', line: 10, column: 7 }],
        });
        parseLogStub.returns({ diagnostics: [diag] });
        existsSyncStub.returns(true);
        readFileSyncStub.returns('line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\n    broken_call();\n');

        DiagnosticsManager.parseAndPublish('log content');

        const collection = _getDiagnosticCollectionForTest() as any;
        const published = collection.get(vscode.Uri.file('/workspace/test.cpp'));
        expect(published).to.have.length(1);
        expect(published[0].range.start.line).to.equal(9);
        expect(published[0].range.start.character).to.equal(6);
        expect((published[0] as any).msAgentIndex).to.equal(0);
    });

    it('resolves diagnostics for a specific file path', () => {
        const diag1 = makeDiag({ fileName: '/workspace/file1.cpp' });
        const diag2 = makeDiag({ fileName: '/workspace/file2.cpp', errorType: 'MEM_LEAK' });
        parseLogStub.returns({ diagnostics: [diag1, diag2] });
        existsSyncStub.returns(true);
        readFileSyncStub.returns('int main() {}\n');

        DiagnosticsManager.parseAndPublish('log');
        const result = DiagnosticsManager.getDiagnosticForFile('/workspace/file1.cpp');

        expect(result).to.have.length(1);
        expect(result[0].fileName).to.equal('/workspace/file1.cpp');
    });
});
