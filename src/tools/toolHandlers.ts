import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ToolContext {
    workspaceRoot: string;
    diagnostics?: unknown;
}

export interface ToolHandler {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute(params: Record<string, unknown>, context: ToolContext): Promise<string>;
}

const readFileHandler: ToolHandler = {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the file content with line numbers.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute or workspace-relative file path' },
            startLine: { type: 'number', description: 'Start line (1-based, optional)' },
            endLine: { type: 'number', description: 'End line (1-based, optional)' },
        },
        required: ['path'],
    },
    async execute(params, context) {
        const filePath = resolvePath(params.path as string, context.workspaceRoot);
        if (!fs.existsSync(filePath)) {
            return `Error: File not found: ${filePath}`;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const start = Math.max(1, (params.startLine as number) || 1);
        const end = Math.min(lines.length, (params.endLine as number) || lines.length);
        const selected = lines.slice(start - 1, end);
        return selected.map((line, i) => `${start + i}: ${line}`).join('\n');
    },};

const editFileHandler: ToolHandler = {
    name: 'edit_file',
    description: 'Apply a search-and-replace edit to a file. Finds oldText exactly and replaces with newText. Alternatively, replace a range of lines by providing startLine/endLine.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute or workspace-relative file path' },
            oldText: { type: 'string', description: 'Exact text to find (must be unique in the file unless replaceAll is true)' },
            newText: { type: 'string', description: 'Replacement text' },
            startLine: { type: 'number', description: 'Start line (1-based, optional). Replaces lines [startLine, endLine] with newText when oldText is not provided.' },
            endLine: { type: 'number', description: 'End line (1-based, optional). Defaults to startLine if not provided.' },
            replaceAll: { type: 'boolean', description: 'If true, replace all occurrences of oldText. Default false.' },
        },
        required: ['path', 'newText'],
    },
    async execute(params, context) {
        const filePath = resolvePath(params.path as string, context.workspaceRoot);
        if (!fs.existsSync(filePath)) {
            return `Error: File not found: ${filePath}`;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        const newText = params.newText as string;

        if (params.startLine !== undefined && params.oldText === undefined) {
            const lines = content.split('\n');
            const startLine = Math.max(1, params.startLine as number);
            const endLine = params.endLine !== undefined
                ? Math.min(lines.length, params.endLine as number)
                : startLine;
            const before = lines.slice(0, startLine - 1);
            const after = lines.slice(endLine);
            const updated = [...before, newText, ...after].join('\n');
            fs.writeFileSync(filePath, updated, 'utf-8');
            return `Success: Replaced lines ${startLine}-${endLine} with new content.`;
        }

        if (params.oldText === undefined) {
            return `Error: Must provide either oldText or startLine.`;
        }

        let oldText = params.oldText as string;

        let idx = content.indexOf(oldText);

        if (idx === -1) {
            const normalizedOld = oldText.replace(/[ \t]+/g, ' ').trim();
            const normalizedContent = content.replace(/[ \t]+/g, ' ');
            const normIdx = normalizedContent.indexOf(normalizedOld);

            if (normIdx !== -1) {
                let actualStart = 0;
                let charCount = 0;
                for (let i = 0; i < content.length; i++) {
                    if (content[i] !== ' ' && content[i] !== '\t') {
                        while (charCount < normIdx && i < content.length) {
                            if (content[i] !== ' ' && content[i] !== '\t') charCount++;
                            i++;
                        }
                        actualStart = i;
                        break;
                    }
                }

                const lines = content.split('\n');
                let lineNum = 1;
                let pos = 0;
                for (const line of lines) {
                    if (pos + line.length >= actualStart) break;
                    pos += line.length + 1;
                    lineNum++;
                }

                const targetLine = lines[lineNum - 1] || '';
                const matchIdx = targetLine.indexOf(oldText.trim().split('\n')[0]);
                if (matchIdx !== -1) {
                    const actualOldText = targetLine.substring(matchIdx);
                    idx = content.indexOf(actualOldText);
                    oldText = actualOldText;
                }
            }
        }

        if (idx === -1) {
            const snippet = content.substring(0, 200);
            return `Error: oldText not found in ${filePath}.\n\nFile starts with:\n${snippet}\n\nSearched for:\n${oldText.substring(0, 100)}...`;
        }

        if (params.replaceAll) {
            let updated = content;
            let count = 0;
            while (updated.includes(oldText)) {
                updated = updated.replace(oldText, newText);
                count++;
            }
            if (count === 0) {
                return `Error: oldText not found in ${filePath}.`;
            }
            fs.writeFileSync(filePath, updated, 'utf-8');
            return `Success: Replaced ${count} occurrences.`;
        }

        const updated = content.substring(0, idx) + newText + content.substring(idx + oldText.length);
        fs.writeFileSync(filePath, updated, 'utf-8');

        const oldLines = oldText.split('\n').length;
        const newLines = newText.split('\n').length;
        return `Success: Applied edit at line ~${content.substring(0, idx).split('\n').length}. Replaced ${oldLines} lines with ${newLines} lines.`;
    },
};

const listFilesHandler: ToolHandler = {
    name: 'list_files',
    description: 'List files in the workspace directory.',
    inputSchema: {
        type: 'object',
        properties: {
            directory: { type: 'string', description: 'Directory to list (defaults to workspace root)' },
        },
        required: [],
    },
    async execute(params, context) {
        const dir = resolvePath((params.directory as string) || '.', context.workspaceRoot);
        if (!fs.existsSync(dir)) {
            return `Error: Directory not found: ${dir}`;
        }
        const entries: string[] = [];
        function walk(d: string) {
            const items = fs.readdirSync(d, { withFileTypes: true });
            for (const item of items) {
                const full = path.join(d, item.name);
                if (item.isDirectory()) {
                    walk(full);
                } else {
                    entries.push(full);
                }
            }
        }
        walk(dir);
        return entries.slice(0, 50).join('\n') || 'No files found.';
    },
};

const readDiagnosticsHandler: ToolHandler = {
    name: 'read_diagnostics',
    description: 'Read the current mssanitizer diagnostics for a file.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File path to get diagnostics for (optional, returns all if omitted)' },
        },
        required: [],
    },
    async execute(params, context) {
        const diags = context.diagnostics;
        if (!diags) {
            return 'No diagnostics loaded. Parse a log file first.';
        }
        return JSON.stringify(diags, null, 2);
    },
};

const searchInFilesHandler: ToolHandler = {
    name: 'search_in_files',
    description: 'Search for a query string across files in the workspace. Returns matching file paths with line numbers and snippets.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Text to search for' },
            directory: { type: 'string', description: 'Directory to search in (defaults to workspace root)' },
            glob: { type: 'string', description: 'File pattern to filter by, e.g. "*.cpp" or "*.ts" (optional)' },
        },
        required: ['query'],
    },
    async execute(params, context) {
        const query = (params.query as string).toLowerCase();
        const dir = resolvePath((params.directory as string) || '.', context.workspaceRoot);
        const glob = params.glob as string | undefined;

        if (!fs.existsSync(dir)) {
            return `Error: Directory not found: ${dir}`;
        }

        const matches: string[] = [];

        function walk(d: string) {
            if (matches.length >= 20) { return; }
            const items = fs.readdirSync(d, { withFileTypes: true });
            for (const item of items) {
                if (matches.length >= 20) { return; }
                const full = path.join(d, item.name);
                if (item.isDirectory()) {
                    walk(full);
                } else {
                    if (glob) {
                        if (glob.startsWith('*')) {
                            const ext = glob.slice(1);
                            if (!full.endsWith(ext)) {
                                continue;
                            }
                        } else if (!path.basename(full).includes(glob)) {
                            continue;
                        }
                    }
                    try {
                        const fileContent = fs.readFileSync(full, 'utf-8');
                        const lines = fileContent.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].toLowerCase().includes(query)) {
                                matches.push(`${full}:${i + 1}: ${lines[i].trimEnd()}`);
                                if (matches.length >= 20) {
                                    return;
                                }
                            }
                        }
                    } catch {
                    }
                }
            }
        }
        walk(dir);
        return matches.join('\n') || 'No matches found';
    },
};

const applyPatchHandler: ToolHandler = {
    name: 'apply_patch',
    description: 'Apply a patch to a file. The patch is a list of line replacements separated by ---. Each replacement is: OLD_LINE\\n->\\nNEW_LINE.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute or workspace-relative file path' },
            patch: { type: 'string', description: 'Patch content with line replacements' },
            replaceAll: { type: 'boolean', description: 'If true, replace all occurrences of each old line. Default false.' },
        },
        required: ['path', 'patch'],
    },
    async execute(params, context) {
        const filePath = resolvePath(params.path as string, context.workspaceRoot);
        if (!fs.existsSync(filePath)) {
            return `Error: File not found: ${filePath}`;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const patch = params.patch as string;
        const replaceAll = (params.replaceAll as boolean) || false;

        const replacements = patch.split('\n---\n');
        let successCount = 0;
        const errors: string[] = [];

        for (const replacement of replacements) {
            const parts = replacement.split('\n->\n');
            if (parts.length !== 2) {
                errors.push(`Invalid replacement block (missing -> separator):\\n${replacement}`);
                continue;
            }
            const oldLine = parts[0];
            const newLine = parts[1];

            let found = false;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i] === oldLine) {
                    lines[i] = newLine;
                    successCount++;
                    found = true;
                    if (!replaceAll) {
                        break;
                    }
                }
            }

            if (!found) {
                errors.push(`Line not found: "${oldLine}"`);
            }
        }

        if (errors.length > 0) {
            return `Error: ${errors.length} replacement(s) failed.\\n${errors.join('\\n')}`;
        }

        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return `Success: Applied ${successCount} replacement(s).`;
    },
};

const getWorkspaceInfoHandler: ToolHandler = {
    name: 'get_workspace_info',
    description: 'Get information about the current workspace.',
    inputSchema: {
        type: 'object',
        properties: {},
        required: [],
    },
    async execute(_params, context) {
        return JSON.stringify({
            workspaceRoot: context.workspaceRoot,
            hasDiagnostics: !!context.diagnostics,
        });
    },
};

function resolvePath(input: string, workspaceRoot: string): string {
    if (path.isAbsolute(input)) {
        return input;
    }
    return path.resolve(workspaceRoot, input);
}

export const ALL_TOOLS: ToolHandler[] = [
    readFileHandler,
    editFileHandler,
    listFilesHandler,
    readDiagnosticsHandler,
    searchInFilesHandler,
    applyPatchHandler,
    getWorkspaceInfoHandler,
];

export function getToolDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return ALL_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

export async function executeTool(
    name: string,
    params: Record<string, unknown>,
    context: ToolContext,
): Promise<string> {
    const tool = ALL_TOOLS.find(t => t.name === name);
    if (!tool) {
        return `Error: Unknown tool: ${name}`;
    }
    try {
        return await tool.execute(params, context);
    } catch (e) {
        return `Error executing ${name}: ${e instanceof Error ? e.message : String(e)}`;
    }
}
