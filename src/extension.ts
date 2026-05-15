import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DiagnosticsManager } from './vscode/diagnosticsManager';
import {
    fixProblem,
    fixIssue,
    fixAllDiagnostics,
    showFixDetailsPanel,
    getAiFixQueueSnapshot,
    getAiFixQueueStates,
    resetAiFixHistory,
    type FixProblemOptions,
    type FixProblemResult,
} from './vscode/fixService';
import { registerFixActions } from './vscode/codeActionProvider';
import { Severity } from './parser/types';
import type { ParseResult } from './parser/types';
import { disposeAllManagedServers } from './backends/opencodeTransport';
import { getLLMConfig } from './llm/config';
import {
    loadOpenCodeModelCatalog,
    OpenCodeModelEntry,
} from './llm/opencodeModelCatalog';
import {
    DEFAULT_OPENCODE_MODEL,
    LEGACY_DEFAULT_OPENCODE_MODELS,
} from './llm/configResolver';
import { createActivityChannel, type ActivityChannel } from './vscode/activityChannel';

let outputChannel: vscode.OutputChannel;
let activityChannel: ActivityChannel | undefined;

export const _deps = {
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    readFileSync: fs.readFileSync,
    loadOpenCodeModelCatalog,
};

export function _setTestDeps(deps: Partial<typeof _deps>) {
    Object.assign(_deps, deps);
}

export function _resetTestDeps() {
    _deps.existsSync = fs.existsSync;
    _deps.statSync = fs.statSync;
    _deps.readFileSync = fs.readFileSync;
    _deps.loadOpenCodeModelCatalog = loadOpenCodeModelCatalog;
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('msAgent extension is now active');

    outputChannel = vscode.window.createOutputChannel('msAgent');
    context.subscriptions.push(outputChannel);

    outputChannel.appendLine('========================================');
    outputChannel.appendLine('msAgent extension activated');
    outputChannel.appendLine('Timestamp: ' + new Date().toISOString());
    outputChannel.appendLine('========================================');
    outputChannel.appendLine('');

    // Separate, low-noise channel that surfaces what OpenCode is actively
    // doing (tool calls, stalls, outcomes). The main `msAgent` channel above
    // is the verbose one used for post-mortem debugging; this one answers
    // "what is OpenCode doing right now?" while a fix is in flight.
    activityChannel = createActivityChannel();
    context.subscriptions.push({ dispose: () => activityChannel?.dispose() });
    activityChannel.appendLine(`msAgent activity channel ready — ${new Date().toISOString()}`);

    (global as any).msAgentContext = context;
    (global as any).msAgentOutputChannel = outputChannel;
    /** Same extension-host process as mstt; avoids executeCommand quirks while fixProblem is in flight. */
    (globalThis as any).__msAgentGetAiFixQueueSnapshot = () => getAiFixQueueSnapshot();
    (globalThis as any).__msAgentGetAiFixQueueStates = () => getAiFixQueueStates();

    DiagnosticsManager.activate(context);
    await syncInitialOpenCodeModel();

    /**
     * Parse a sanitizer log and publish diagnostics.
     * - With `logPath` (Uri or string): parse that file (absolute or workspace-relative).
     * - Without `logPath`: open file dialog (same as palette use).
     * executeCommand('msagent.parseLog', logPath?, { suppressMessage?: boolean })
     */
    const parseLogCmd = vscode.commands.registerCommand(
        'msagent.parseLog',
        async (
            logPath?: vscode.Uri | string,
            options?: { suppressMessage?: boolean },
        ): Promise<ParseResult | undefined> => {
            let fsPath = resolveLogInputToFsPath(logPath);
            if (!fsPath) {
                const uri = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectMany: false,
                    filters: { 'msAgent Logs': ['log', 'txt'], 'All Files': ['*'] },
                    title: 'Select msAgent Log File',
                });
                if (!uri?.[0]) {
                    return undefined;
                }
                fsPath = uri[0].fsPath;
            }
            if (!_deps.existsSync(fsPath) || !_deps.statSync(fsPath).isFile()) {
                if (!options?.suppressMessage) {
                    vscode.window.showErrorMessage(`msAgent: log file not found: ${fsPath}`);
                }
                return undefined;
            }
            return parseLogAtPathAndNotify(fsPath, options?.suppressMessage === true);
        },
    );

    /** Fix problem at index (0-based) from the last parse. executeCommand('msagent.fixProblem', index, options?) */
    const fixProblemCmd = vscode.commands.registerCommand(
        'msagent.fixProblem',
        async (
            index: number | string | undefined,
            options?: FixProblemOptions,
        ): Promise<FixProblemResult> => {
            const idx = parseProblemIndex(index);
            outputChannel.appendLine(`[CMD] msagent.fixProblem rawIndex=${String(index)} parsedIndex=${idx === null ? 'invalid' : idx}`);
            if (idx === null) {
                vscode.window.showErrorMessage(
                    'msAgent: fixProblem requires a 0-based problem index (number or numeric string).',
                );
                return { status: 'invalid_index' };
            }
            const result = await fixProblem(idx, options ?? {});
            outputChannel.appendLine(`[CMD] msagent.fixProblem index=${idx} status=${result.status}`);
            return result;
        },
    );
    /** Fix one caller-owned issue payload. executeCommand('msagent.fixIssue', request) */
    const fixIssueCmd = vscode.commands.registerCommand(
        'msagent.fixIssue',
        async (request?: unknown): Promise<FixProblemResult> => {
            const result = await fixIssue(request);
            outputChannel.appendLine(`[CMD] msagent.fixIssue status=${result.status}`);
            return result;
        },
    );
    const showFixDetailsCmd = vscode.commands.registerCommand('msagent.showFixDetails', () => {
        showFixDetailsPanel();
    });

    const getAiFixQueueStatesCmd = vscode.commands.registerCommand(
        'msagent.getAiFixQueueStates',
        () => {
            const states = getAiFixQueueStates();
            outputChannel.appendLine(`[CMD] msagent.getAiFixQueueStates ${JSON.stringify(states)}`);
            return states;
        },
    );
    const getAiFixQueueSnapshotCmd = vscode.commands.registerCommand(
        'msagent.getAiFixQueueSnapshot',
        () => {
            const snapshot = getAiFixQueueSnapshot();
            outputChannel.appendLine(`[CMD] msagent.getAiFixQueueSnapshot ${JSON.stringify(snapshot)}`);
            return snapshot;
        },
    );

    const fixAllCmd = vscode.commands.registerCommand('msagent.fixAll', async (uri?: vscode.Uri) => {
        const fileUri = uri ? uri.toString() : vscode.window.activeTextEditor?.document.uri.toString();
        if (!fileUri) {
            vscode.window.showWarningMessage('No file open to fix. Open a file with msAgent diagnostics first.');
            return;
        }
        await fixAllDiagnostics(fileUri);
    });

    const clearDiagsCmd = vscode.commands.registerCommand('msagent.clearDiagnostics', () => {
        DiagnosticsManager.clearDiagnostics();
        vscode.window.showInformationMessage('msAgent diagnostics cleared.');
    });

    const selectModelCmd = vscode.commands.registerCommand('msagent.selectModel', selectOpenCodeModel);
    const openSettingsCmd = vscode.commands.registerCommand('msagent.openSettings', openMsAgentSettings);

    context.subscriptions.push(
        parseLogCmd,
        fixProblemCmd,
        fixIssueCmd,
        showFixDetailsCmd,
        getAiFixQueueStatesCmd,
        getAiFixQueueSnapshotCmd,
        fixAllCmd,
        clearDiagsCmd,
        selectModelCmd,
        openSettingsCmd,
        registerFixActions(context),
    );
}

export function deactivate() {
    delete (globalThis as any).__msAgentGetAiFixQueueSnapshot;
    delete (globalThis as any).__msAgentGetAiFixQueueStates;
    disposeAllManagedServers();
    if (outputChannel) {
        outputChannel.appendLine('msAgent extension deactivated');
    }
}

export function parseProblemIndex(index: number | string | undefined): number | null {
    if (index === undefined || index === '') {
        return null;
    }
    const n = typeof index === 'number' ? index : Number(String(index).trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        return null;
    }
    return n;
}

export function resolveLogInputToFsPath(uriOrPath: vscode.Uri | string | undefined): string | undefined {
    if (uriOrPath === undefined || uriOrPath === null) {
        return undefined;
    }
    if (uriOrPath instanceof vscode.Uri) {
        return uriOrPath.fsPath;
    }
    const s = String(uriOrPath).trim();
    if (!s) {
        return undefined;
    }
    if (path.isAbsolute(s)) {
        return s;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
        return undefined;
    }
    return path.normalize(path.join(folder, s));
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
    modelID: string;
}

function getWorkspaceRoots(): string[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length > 0) {
        return folders.map((folder) => folder.uri.fsPath);
    }
    return vscode.workspace.rootPath ? [vscode.workspace.rootPath] : [];
}

function describeModelEntry(entry: OpenCodeModelEntry): string {
    switch (entry.source) {
        case 'workspace':
            return entry.sourcePath ? `Workspace config: ${entry.sourcePath}` : 'Workspace OpenCode config';
        case 'user':
            return entry.sourcePath ? `User config: ${entry.sourcePath}` : 'User OpenCode config';
        case 'built-in':
            return 'Built-in free OpenCode model';
        default:
            return 'OpenCode model';
    }
}

function getMsAgentConfiguration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('msagent');
}

function getEffectiveExplicitModelValue(
    configuration: vscode.WorkspaceConfiguration,
): string | undefined {
    const inspect = typeof configuration.inspect === 'function'
        ? configuration.inspect<string>('modelName')
        : undefined;
    const candidate =
        inspect?.workspaceFolderValue
        ?? inspect?.workspaceValue
        ?? inspect?.globalValue;
    return typeof candidate === 'string' ? candidate : undefined;
}

function shouldSyncInitialModel(configuration: vscode.WorkspaceConfiguration): boolean {
    const explicitValue = getEffectiveExplicitModelValue(configuration);
    if (explicitValue === undefined) {
        return true;
    }
    const trimmed = explicitValue.trim();
    return trimmed.length === 0 || LEGACY_DEFAULT_OPENCODE_MODELS.includes(trimmed as typeof LEGACY_DEFAULT_OPENCODE_MODELS[number]);
}

function getPreferredOpenCodeModel(entries: OpenCodeModelEntry[]): string {
    const configured = entries.find((entry) => entry.source !== 'built-in');
    return configured?.id ?? DEFAULT_OPENCODE_MODEL;
}

async function syncInitialOpenCodeModel(): Promise<void> {
    const configuration = getMsAgentConfiguration();
    if (!shouldSyncInitialModel(configuration)) {
        return;
    }

    const entries = _deps.loadOpenCodeModelCatalog({ workspaceRoots: getWorkspaceRoots() });
    const nextModel = getPreferredOpenCodeModel(entries);
    const currentModel = configuration.get<string>('modelName')?.trim();
    if (currentModel === nextModel) {
        return;
    }

    const target = (vscode.workspace.workspaceFolders?.length ?? 0) > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await configuration.update('modelName', nextModel, target);
    outputChannel.appendLine(`[Config] synced initial OpenCode model to ${nextModel}`);
}

export async function selectOpenCodeModel(): Promise<string | undefined> {
    const entries = _deps.loadOpenCodeModelCatalog({ workspaceRoots: getWorkspaceRoots() })
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));

    if (entries.length === 0) {
        vscode.window.showWarningMessage('msAgent: no OpenCode models found in config files or built-in fallback list.');
        return undefined;
    }

    const currentModel = getLLMConfig().modelFullName;
    const items: ModelQuickPickItem[] = entries.map((entry) => ({
        label: entry.id,
        description: entry.id === currentModel ? 'Current' : entry.source,
        detail: describeModelEntry(entry),
        modelID: entry.id,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        title: 'msAgent: Select OpenCode Model',
        placeHolder: 'Choose the full OpenCode model ID for repair sessions',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!selected) {
        return undefined;
    }

    const target = (vscode.workspace.workspaceFolders?.length ?? 0) > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('msagent').update('modelName', selected.modelID, target);
    vscode.window.showInformationMessage(`msAgent OpenCode model set to ${selected.modelID}`);
    return selected.modelID;
}

export async function openMsAgentSettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'msagent');
}

function parseLogAtPathAndNotify(fsPath: string, suppressMessage?: boolean): ParseResult {
    resetAiFixHistory();
    const result = DiagnosticsManager.parseFileAndPublish(fsPath);
    if (!suppressMessage) {
        const count = result.diagnostics.length;
        const errors = result.diagnostics.filter((d) => d.severity === Severity.ERROR).length;
        const warnings = result.diagnostics.filter((d) => d.severity === Severity.WARNING).length;
        const message =
            count === 0
                ? 'No diagnostics found in log file.'
                : `Found ${count} diagnostics (${errors} errors, ${warnings} warnings)`;
        vscode.window.showInformationMessage(message);
    }
    return result;
}
