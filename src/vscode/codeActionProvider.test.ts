import { expect } from 'chai';
import { FixActionProvider, registerFixActions } from './codeActionProvider';
import * as vscode from 'vscode';

(vscode.languages as any).registerCodeActionsProvider = (_selector: unknown, _provider: unknown) => ({
    dispose: () => {},
});

class MockRange {
    readonly start: { line: number; character: number };
    readonly end: { line: number; character: number };

    constructor(
        start: { line: number; character: number },
        end: { line: number; character: number },
    ) {
        this.start = start;
        this.end = end;
    }
}

function makeDiagnostic(message: string, line: number, source?: string, index?: number): any {
    return {
        message,
        range: new MockRange({ line, character: 4 }, { line, character: 10 }),
        source,
        msAgentIndex: index,
    };
}

function makeContext(diagnostics: any[]): any {
    return { diagnostics };
}

const mockToken: vscode.CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
};

describe('FixActionProvider', () => {
    let provider: FixActionProvider;

    beforeEach(() => {
        provider = new FixActionProvider({} as vscode.ExtensionContext);
    });

    it('returns empty array when there are no msagent diagnostics', () => {
        const result = provider.provideCodeActions(
            {} as vscode.TextDocument,
            new MockRange({ line: 0, character: 0 }, { line: 0, character: 1 }) as any,
            makeContext([makeDiagnostic('Other error', 0, 'other', 0)]),
            mockToken,
        );

        expect(result).to.deep.equal([]);
    });

    it('routes quick fix through msagent.fixProblem using the diagnostic index', () => {
        const result = provider.provideCodeActions(
            {} as vscode.TextDocument,
            new MockRange({ line: 5, character: 0 }, { line: 5, character: 10 }) as any,
            makeContext([makeDiagnostic('[msAgent] OUT_OF_BOUNDS', 5, 'msagent', 7)]),
            mockToken,
        ) as vscode.CodeAction[];

        expect(result).to.have.lengthOf(1);
        expect(result[0].title).to.equal('Fix: OUT_OF_BOUNDS');
        expect(result[0].command?.command).to.equal('msagent.fixProblem');
        expect(result[0].command?.arguments).to.deep.equal([7, { clearWebview: true }]);
    });

    it('skips diagnostics without msAgentIndex metadata', () => {
        const result = provider.provideCodeActions(
            {} as vscode.TextDocument,
            new MockRange({ line: 2, character: 0 }, { line: 2, character: 1 }) as any,
            makeContext([makeDiagnostic('[msAgent] MEM_LEAK', 2, 'msagent')]),
            mockToken,
        ) as vscode.CodeAction[];

        expect(result).to.deep.equal([]);
    });

    it('registers a provider disposable', () => {
        const disposable = registerFixActions({} as vscode.ExtensionContext);
        expect(disposable).to.have.property('dispose');
    });
});
