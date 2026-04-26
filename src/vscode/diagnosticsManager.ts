import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseLog, parseLogFile } from '../parser/logParser';
import { SanitizerDiagnostic, Severity } from '../parser/types';

const _deps = {
    existsSync: fs.existsSync,
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
};

export function _setTestDeps(deps: Partial<typeof _deps>) {
    Object.assign(_deps, deps);
}

export function _resetTestDeps() {
    _deps.existsSync = fs.existsSync;
    _deps.readdirSync = fs.readdirSync;
    _deps.readFileSync = fs.readFileSync;
}

export function _getDiagnosticCollectionForTest(): vscode.DiagnosticCollection | undefined {
    return diagnosticCollection;
}

let diagnosticCollection: vscode.DiagnosticCollection | undefined;
let currentDiagnostics: SanitizerDiagnostic[] = [];
let lastLogDir: string | undefined;

export class DiagnosticsManager {
    private constructor() {}

    static activate(context: vscode.ExtensionContext) {
        diagnosticCollection = vscode.languages.createDiagnosticCollection('msagent');
        context.subscriptions.push(diagnosticCollection);
    }

    static parseAndPublish(logContent: string) {
        const result = parseLog(logContent);
        currentDiagnostics = result.diagnostics;
        lastLogDir = vscode.workspace.rootPath || undefined;
        
        const workspaceRoot = vscode.workspace.rootPath || '';
        const searchDirs = [workspaceRoot, lastLogDir].filter((v): v is string => Boolean(v));
        for (const d of currentDiagnostics) {
            const resolvedUri = DiagnosticsManager.resolveFileUri(d.fileName, searchDirs);
            if (resolvedUri) {
                d.fileName = resolvedUri.fsPath;
            }
        }
        
        DiagnosticsManager.publishDiagnostics();
        return result;
    }

    static parseFileAndPublish(filePath: string) {
        const result = parseLogFile(filePath);
        currentDiagnostics = result.diagnostics;
        const resolved = path.normalize(path.resolve(filePath));
        lastLogDir = path.dirname(resolved);
        
        const workspaceRoot = vscode.workspace.rootPath || '';
        const searchDirs = [workspaceRoot, lastLogDir].filter((v): v is string => Boolean(v));
        for (const d of currentDiagnostics) {
            const resolvedUri = DiagnosticsManager.resolveFileUri(d.fileName, searchDirs);
            if (resolvedUri) {
                d.fileName = resolvedUri.fsPath;
            }
        }
        
        DiagnosticsManager.publishDiagnostics();
        return result;
    }

    static publishDiagnostics() {
        if (!diagnosticCollection) {
            return;
        }

        const workspaceRoot = vscode.workspace.rootPath || '';
        const searchDirs = [
            workspaceRoot,
            lastLogDir,
        ].filter((v): v is string => Boolean(v));

        const groupByFile = new Map<string, vscode.Diagnostic[]>();
        currentDiagnostics.forEach((d, index) => {
            const resolvedUri = DiagnosticsManager.resolveFileUri(d.fileName, searchDirs);
            if (!resolvedUri) {
                return;
            }
            const uriStr = resolvedUri.toString();
            const existing = groupByFile.get(uriStr) || [];
            existing.push(DiagnosticsManager.toVSCodeDiagnostic(d, searchDirs, index));
            groupByFile.set(uriStr, existing);
        });

        const entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
        for (const [uriStr, diags] of groupByFile) {
            entries.push([vscode.Uri.parse(uriStr), diags]);
        }
        diagnosticCollection.set(entries);
    }

    static clearDiagnostics() {
        currentDiagnostics = [];
        lastLogDir = undefined;
        if (diagnosticCollection) {
            diagnosticCollection.clear();
        }
    }

    static getCurrentDiagnostics(): SanitizerDiagnostic[] {
        return [...currentDiagnostics];
    }

    static getLastLogDir(): string | undefined {
        return lastLogDir;
    }

    static getDiagnosticForFile(filePath: string): SanitizerDiagnostic[] {
        const normalized = filePath.replace(/\\/g, '/');
        return currentDiagnostics.filter(d => {
            const resolvedUri = DiagnosticsManager.resolveFileUri(
                d.fileName,
                [path.dirname(normalized), vscode.workspace.rootPath || ''],
            );
            return resolvedUri && resolvedUri.fsPath === normalized;
        });
    }

    /**
     * 解析日志中的文件名为实际文件 URI。
     * 日志里通常只有文件名（如 add_custom.cpp），需要在工作区/日志目录中查找。
     */
    private static resolveFileUri(fileName: string, searchDirs: string[]): vscode.Uri | undefined {
        // 如果已经是绝对路径且文件存在，直接返回
        if (path.isAbsolute(fileName) && _deps.existsSync(fileName)) {
            return vscode.Uri.file(fileName);
        }

        // 在搜索目录中查找匹配的文件
        const baseName = path.basename(fileName);
        for (const dir of searchDirs) {
            if (!dir) {
                continue;
            }
            // 先尝试直接拼接
            const fullPath = path.join(dir, fileName);
            if (_deps.existsSync(fullPath)) {
                return vscode.Uri.file(fullPath);
            }
            // 如果 fileName 就是 basename，递归搜索一层子目录
            if (baseName === fileName) {
                try {
                    const entries = _deps.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
                            const subPath = path.join(dir, entry.name, fileName);
                            if (_deps.existsSync(subPath)) {
                                return vscode.Uri.file(subPath);
                            }
                        }
                    }
                } catch {
                    // ignore
                }
            }
        }

        // 都找不到时，回退到工作区拼接（VSCode 会显示文件未找到但不会崩溃）
        const workspaceRoot = vscode.workspace.rootPath;
        if (workspaceRoot) {
            return vscode.Uri.file(path.join(workspaceRoot, fileName));
        }
        return vscode.Uri.file(fileName);
    }

    private static toVSCodeDiagnostic(
        d: SanitizerDiagnostic,
        searchDirs: string[],
        index: number,
    ): vscode.Diagnostic {
        const range = DiagnosticsManager.resolveDiagnosticRange(d);
        const severity = d.severity === Severity.ERROR
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Warning;
        
        const diag = new vscode.Diagnostic(
            range,
            `[msAgent] ${d.errorType}: ${d.byteSize} bytes at ${d.addressSpace}`,
            severity,
        );
        
        (diag as any).source = 'msagent';
        (diag as any).code = d.errorType;
        (diag as any).msAgentIndex = index;
        
        if (d.callStack && d.callStack.length > 0) {
            diag.relatedInformation = d.callStack.slice(0, 3).map(frame => {
                const frameUri = DiagnosticsManager.resolveFileUri(frame.file, searchDirs) || vscode.Uri.file(frame.file);
                return new vscode.DiagnosticRelatedInformation(
                    new vscode.Location(frameUri, new vscode.Position(Math.max(0, frame.line - 1), frame.column || 0)),
                    `Stack: ${path.basename(frame.file)}:${frame.line}`
                );
            });
        }
        
        return diag;
    }

    private static resolveDiagnosticRange(d: SanitizerDiagnostic): vscode.Range {
        const lineIndex = Math.max(0, d.lineNumber - 1);
        const lineText = DiagnosticsManager.readLineText(d.fileName, lineIndex);
        const startCharacter =
            DiagnosticsManager.resolveDiagnosticColumn(d) ??
            DiagnosticsManager.firstNonWhitespaceCharacter(lineText);
        const endCharacter = Math.max(
            startCharacter + 1,
            lineText.length > 0 ? lineText.length : startCharacter + 1,
        );

        return new vscode.Range(lineIndex, startCharacter, lineIndex, endCharacter);
    }

    private static resolveDiagnosticColumn(d: SanitizerDiagnostic): number | undefined {
        if (!d.callStack || d.callStack.length === 0) {
            return undefined;
        }

        const normalizedFile = path.normalize(d.fileName);
        const directFrame = d.callStack.find((frame) => {
            return (
                typeof frame.column === 'number'
                && path.normalize(frame.file) === normalizedFile
                && frame.line === d.lineNumber
            );
        });
        if (directFrame?.column !== undefined) {
            return Math.max(0, directFrame.column - 1);
        }

        const fallbackFrame = d.callStack.find((frame) => typeof frame.column === 'number');
        return fallbackFrame?.column !== undefined
            ? Math.max(0, fallbackFrame.column - 1)
            : undefined;
    }

    private static readLineText(filePath: string, lineIndex: number): string {
        if (!_deps.existsSync(filePath)) {
            return '';
        }

        try {
            const lines = _deps.readFileSync(filePath, 'utf-8').split(/\r?\n/);
            return lines[lineIndex] ?? '';
        } catch {
            return '';
        }
    }

    private static firstNonWhitespaceCharacter(lineText: string): number {
        const match = /\S/.exec(lineText);
        return match ? match.index : 0;
    }
}
