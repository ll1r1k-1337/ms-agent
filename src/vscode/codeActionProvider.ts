import * as vscode from 'vscode';
import { DiagnosticsManager } from './diagnosticsManager';
import { SanitizerDiagnostic } from '../parser/types';
import { runAgent } from '../agent/agentLoop';
import { OpenAICompatProvider } from '../llm/openaiCompatProvider';
import { LLMProvider } from '../llm/provider';
import { getLLMConfig } from '../llm/config';
import { loadSkill } from '../skills/skillLoader';
import { buildFixPrompt } from '../skills/skillLoader';
import { ToolContext } from '../tools/toolHandlers';

export class FixActionProvider implements vscode.CodeActionProvider {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.CodeAction[]> {
        const diagnostics = context.diagnostics.filter(
            d => d.source === 'msagent',
        );
        if (diagnostics.length === 0) {
            return [];
        }

        const diagnostic = diagnostics[0];
        const title = diagnostic.message.replace('[msAgent] ', '');
        return [{
            title: `Fix: ${title}`,
            kind: vscode.CodeActionKind.QuickFix,
            command: {
                command: 'msagent.fixDiagnostic',
                title: `Fix: ${title}`,
                arguments: [document.uri.toString(), diagnostic.range.start.line],
            },
        }];
    }
}

export function registerFixActions(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new FixActionProvider(context);
    return vscode.languages.registerCodeActionsProvider(
        { scheme: 'file' },
        provider,
    );
}
