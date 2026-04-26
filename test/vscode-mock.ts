export const workspace = {
    rootPath: '/workspace',
    workspaceFolders: undefined as any,
    textDocuments: [] as any[],
    getConfiguration: () => ({
        get: () => undefined,
        update: () => Promise.resolve(),
    }),
    applyEdit: () => Promise.resolve(true),
};

export const window = {
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    createOutputChannel: () => ({ appendLine: () => {}, clear: () => {}, show: () => {} }),
    createWebviewPanel: () => ({
        webview: { html: '', onDidReceiveMessage: () => {}, postMessage: () => Promise.resolve(true), cspSource: 'vscode-resource:' },
        onDidDispose: () => {},
        reveal: () => {},
        dispose: () => {},
    }),
    withProgress: async (_options: unknown, task: (p: unknown, token: unknown) => Promise<unknown>) =>
        task({ report: () => {} }, { onCancellationRequested: () => {} }),
};

export const commands = {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: () => Promise.resolve(),
};

export const DiagnosticSeverity = {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
};

export class Position {
    constructor(public line: number, public character: number) {}
}

export class Range {
    start: Position;
    end: Position;
    constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
        if (typeof a === 'number') {
            this.start = new Position(a, b as number);
            this.end = new Position(c!, d!);
        } else {
            this.start = a;
            this.end = b as Position;
        }
    }
}

export class Location {
    constructor(public uri: Uri, public range: Range) {}
}

export class DiagnosticRelatedInformation {
    constructor(public location: Location, public message: string) {}
}

export class Diagnostic {
    public relatedInformation?: DiagnosticRelatedInformation[];
    public source?: string;
    public code?: string | number;
    constructor(
        public range: Range,
        public message: string,
        public severity?: number,
    ) {}
}

export class Uri {
    static file(path: string): Uri { return new Uri(path); }
    static parse(uri: string): Uri { return new Uri(uri.replace('file://', '')); }
    constructor(public fsPath: string) {}
    toString(): string { return 'file://' + this.fsPath; }
}

export class DiagnosticCollection {
    private entries = new Map<string, Diagnostic[]>();
    set(arg1: Uri | [Uri, Diagnostic[]][], arg2?: Diagnostic[]): void {
        if (Array.isArray(arg1)) {
            this.entries.clear();
            for (const [uri, diags] of arg1) {
                this.entries.set(uri.toString(), diags);
            }
        } else if (arg2) {
            this.entries.set(arg1.toString(), arg2);
        }
    }
    clear(): void { this.entries.clear(); }
    dispose(): void { this.clear(); }
    get(uri: Uri): Diagnostic[] | undefined { return this.entries.get(uri.toString()); }
}

export const languages = {
    createDiagnosticCollection: (name: string) => new DiagnosticCollection(),
    registerCodeActionsProvider: () => ({ dispose: () => {} }),
};

export const ViewColumn = { One: 1, Beside: -2 };

export const ProgressLocation = { Notification: 15, Window: 10 };

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

export class WorkspaceEdit {
    replace() {}
}

export class CodeAction {
    diagnostics?: Diagnostic[];
    command?: { command: string; title: string; arguments?: unknown[] };

    constructor(
        public title: string,
        public kind?: { value: string },
    ) {}
}

export const CodeActionKind = {
    QuickFix: { value: 'quickfix' },
};

export class CancellationTokenSource {
    token = { isCancellationRequested: false, onCancellationRequested: () => {} };
    cancel() {}
    dispose() {}
}

export class EventEmitter<T> {
    event = () => ({ dispose: () => {} });
    fire() {}
    dispose() {}
}

export const env = {};
export const extensions = { all: [] };
