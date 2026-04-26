/**
 * Minimal VSCode API mock for unit testing modules that import vscode.
 */

const configuration = new Map<string, Map<string, unknown>>();

function initConfig(section: string, values: Record<string, unknown>) {
  const map = new Map(Object.entries(values));
  configuration.set(section, map);
}

function clearConfig() {
  configuration.clear();
}

const workspace = {
  workspaceFolders: undefined as any,
  getConfiguration(section: string) {
    const map = configuration.get(section);
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        if (map && map.has(key)) {
          return map.get(key) as T;
        }
        return defaultValue;
      },
      update: () => Promise.resolve(),
    };
  },
};

const Uri = {
  file(filePath: string) {
    return { fsPath: filePath, scheme: 'file' };
  },
};

const languages = {
  getDiagnostics: () => [],
};

const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: () => Promise.resolve(),
};

const window = {
  showErrorMessage: () => Promise.resolve(),
  showWarningMessage: () => Promise.resolve(),
  showInformationMessage: () => Promise.resolve(),
  showQuickPick: () => Promise.resolve(),
  createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
  createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage: () => {} }, dispose: () => {} }),
  activeTextEditor: undefined,
};

const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

const CodeActionKind = {
  QuickFix: { value: 'quickfix' },
};

export const vscodeMock = {
  workspace,
  Uri,
  languages,
  commands,
  window,
  DiagnosticSeverity,
  ConfigurationTarget,
  CodeActionKind,
  initConfig,
  clearConfig,
};

export default vscodeMock;
