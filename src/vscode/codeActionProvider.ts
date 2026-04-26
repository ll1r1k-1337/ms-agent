import * as vscode from 'vscode';

export class FixActionProvider implements vscode.CodeActionProvider {
    constructor(_context: vscode.ExtensionContext) {}

    provideCodeActions(
        _document: vscode.TextDocument,
        _range: vscode.Range,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.CodeAction[]> {
        const diagnostics = context.diagnostics.filter(
            d => d.source === 'msagent',
        );
        if (diagnostics.length === 0) {
            return [];
        }

        const actions: vscode.CodeAction[] = [];
        for (const diagnostic of diagnostics) {
            const index = (diagnostic as any).msAgentIndex;
            if (typeof index !== 'number') {
                continue;
            }

            const title = diagnostic.message.replace('[msAgent] ', '');
            const action = new vscode.CodeAction(
                `Fix: ${title}`,
                vscode.CodeActionKind.QuickFix,
            );
            action.diagnostics = [diagnostic];
            action.command = {
                command: 'msagent.fixProblem',
                title: `Fix: ${title}`,
                arguments: [index, { clearWebview: true }],
            };
            actions.push(action);
        }
        return actions;
    }
}

export function registerFixActions(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new FixActionProvider(context);
    return vscode.languages.registerCodeActionsProvider(
        { scheme: 'file' },
        provider,
    );
}
