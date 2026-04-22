export const workspace = {
    getConfiguration: () => ({
        get: () => undefined,
        update: () => Promise.resolve(),
    }),
};

export const window = {
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
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

export const Uri = {
    parse: (uri: string) => ({ fsPath: uri.replace('file://', '') }),
};

export const ViewColumn = { One: 1, Beside: -2 };

export const ProgressLocation = { Notification: 15, Window: 10 };

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
