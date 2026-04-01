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
    description: 'Apply a search-and-replace edit to a file. Finds oldText exactly and replaces with newText.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute or workspace-relative file path' },
            oldText: { type: 'string', description: 'Exact text to find (must be unique in the file)' },
            newText: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'oldText', 'newText'],
    },
    async execute(params, context) {
        const filePath = resolvePath(params.path as string, context.workspaceRoot);
        if (!fs.existsSync(filePath)) {
            return `Error: File not found: ${filePath}`;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        let oldText = params.oldText as string;
        const newText = params.newText as string;
        
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
