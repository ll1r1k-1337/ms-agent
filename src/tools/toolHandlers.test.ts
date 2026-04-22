import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { executeTool, ALL_TOOLS, getToolDefinitions } from './toolHandlers';
import { ToolContext } from './toolHandlers';

describe('toolHandlers', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msagent-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const ctx: ToolContext = { workspaceRoot: '' };

    describe('getToolDefinitions', () => {
        it('should return definitions for all 7 tools', () => {
            const defs = getToolDefinitions();
            expect(defs).to.have.length(7);
            const names = defs.map(d => d.name);
            expect(names).to.include('read_file');
            expect(names).to.include('edit_file');
            expect(names).to.include('list_files');
            expect(names).to.include('read_diagnostics');
            expect(names).to.include('search_in_files');
            expect(names).to.include('apply_patch');
            expect(names).to.include('get_workspace_info');
        });

        it('each definition should have name, description, and inputSchema', () => {
            for (const def of getToolDefinitions()) {
                expect(def.name).to.be.a('string').and.not.empty;
                expect(def.description).to.be.a('string').and.not.empty;
                expect(def.inputSchema).to.be.an('object');
                expect(def.inputSchema.type).to.equal('object');
            }
        });
    });

    describe('executeTool', () => {
        it('should return error for unknown tool', async () => {
            const result = await executeTool('unknown_tool', {}, ctx);
            expect(result).to.include('Error: Unknown tool');
        });
    });

    describe('read_file', () => {
        it('should read entire file with line numbers', async () => {
            const filePath = path.join(tmpDir, 'test.cpp');
            fs.writeFileSync(filePath, 'line1\nline2\nline3\n');
            const result = await executeTool('read_file', { path: filePath }, ctx);
            expect(result).to.include('1: line1');
            expect(result).to.include('2: line2');
            expect(result).to.include('3: line3');
        });

        it('should read a range of lines', async () => {
            const filePath = path.join(tmpDir, 'test.cpp');
            fs.writeFileSync(filePath, 'a\nb\nc\nd\ne\n');
            const result = await executeTool('read_file', { path: filePath, startLine: 2, endLine: 4 }, ctx);
            expect(result).to.include('2: b');
            expect(result).to.include('3: c');
            expect(result).to.include('4: d');
            expect(result).not.to.include('1: a');
            expect(result).not.to.include('5: e');
        });

        it('should return error for missing file', async () => {
            const result = await executeTool('read_file', { path: '/nonexistent/file.cpp' }, ctx);
            expect(result).to.include('Error: File not found');
        });

        it('should resolve relative paths against workspaceRoot', async () => {
            const filePath = path.join(tmpDir, 'src.cpp');
            fs.writeFileSync(filePath, 'content');
            const relCtx: ToolContext = { workspaceRoot: tmpDir };
            const result = await executeTool('read_file', { path: 'src.cpp' }, relCtx);
            expect(result).to.include('content');
        });
    });

    describe('edit_file', () => {
        it('should replace exact text in file', async () => {
            const filePath = path.join(tmpDir, 'test.cpp');
            fs.writeFileSync(filePath, 'int x = 0;\nint y = 1;\n');
            const result = await executeTool('edit_file', {
                path: filePath,
                oldText: 'int x = 0;',
                newText: 'int x = 42;',
            }, ctx);
            expect(result).to.include('Success');
            const updated = fs.readFileSync(filePath, 'utf-8');
            expect(updated).to.include('int x = 42;');
            expect(updated).to.include('int y = 1;');
        });

        it('should return error when oldText not found', async () => {
            const filePath = path.join(tmpDir, 'test.cpp');
            fs.writeFileSync(filePath, 'some code\n');
            const result = await executeTool('edit_file', {
                path: filePath,
                oldText: 'nonexistent text',
                newText: 'replacement',
            }, ctx);
            expect(result).to.include('Error: oldText not found');
        });

        it('should return error for missing file', async () => {
            const result = await executeTool('edit_file', {
                path: '/nonexistent/file.cpp',
                oldText: 'x',
                newText: 'y',
            }, ctx);
            expect(result).to.include('Error: File not found');
        });

        it('should replace lines by startLine/endLine', async () => {
            const filePath = path.join(tmpDir, 'test.cpp');
            fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\n');
            const result = await executeTool('edit_file', {
                path: filePath,
                startLine: 2,
                endLine: 3,
                newText: 'replaced',
            }, ctx);
            expect(result).to.include('Success: Replaced lines 2-3');
            const updated = fs.readFileSync(filePath, 'utf-8');
            expect(updated).to.equal('line1\nreplaced\nline4\n');
        });

        it('should replace all occurrences when replaceAll is true', async () => {
            const filePath = path.join(tmpDir, 'test.cpp');
            fs.writeFileSync(filePath, 'int x = 1;\nint x = 2;\n');
            const result = await executeTool('edit_file', {
                path: filePath,
                oldText: 'int x =',
                newText: 'int y =',
                replaceAll: true,
            }, ctx);
            expect(result).to.include('Success: Replaced 2 occurrences');
            const updated = fs.readFileSync(filePath, 'utf-8');
            expect(updated).to.equal('int y = 1;\nint y = 2;\n');
        });
    });

    describe('list_files', () => {
        it('should list files in directory', async () => {
            fs.writeFileSync(path.join(tmpDir, 'a.cpp'), '');
            fs.writeFileSync(path.join(tmpDir, 'b.cpp'), '');
            const result = await executeTool('list_files', { directory: tmpDir }, ctx);
            expect(result).to.include('a.cpp');
            expect(result).to.include('b.cpp');
        });

        it('should list files recursively', async () => {
            const subDir = path.join(tmpDir, 'sub');
            fs.mkdirSync(subDir);
            fs.writeFileSync(path.join(subDir, 'c.cpp'), '');
            const result = await executeTool('list_files', { directory: tmpDir }, ctx);
            expect(result).to.include('c.cpp');
        });

        it('should return error for missing directory', async () => {
            const result = await executeTool('list_files', { directory: '/nonexistent/dir' }, ctx);
            expect(result).to.include('Error: Directory not found');
        });
    });

    describe('read_diagnostics', () => {
        it('should return message when no diagnostics loaded', async () => {
            const result = await executeTool('read_diagnostics', {}, ctx);
            expect(result).to.include('No diagnostics loaded');
        });

        it('should serialize diagnostics as JSON', async () => {
            const diagCtx: ToolContext = {
                workspaceRoot: '',
                diagnostics: [{ errorType: 'OUT_OF_BOUNDS', line: 10 }],
            };
            const result = await executeTool('read_diagnostics', {}, diagCtx);
            const parsed = JSON.parse(result);
            expect(parsed).to.have.length(1);
            expect(parsed[0].errorType).to.equal('OUT_OF_BOUNDS');
        });
    });

    describe('search_in_files', () => {
        it('should return matching results with file paths and line numbers', async () => {
            fs.writeFileSync(path.join(tmpDir, 'a.cpp'), 'int foo = 1;\nint bar = 2;\n');
            fs.writeFileSync(path.join(tmpDir, 'b.cpp'), 'float foo = 3.0;\n');
            const result = await executeTool('search_in_files', { query: 'foo', directory: tmpDir }, ctx);
            expect(result).to.include('a.cpp:1:');
            expect(result).to.include('b.cpp:1:');
        });

        it('should return "No matches found" when query does not match', async () => {
            fs.writeFileSync(path.join(tmpDir, 'a.cpp'), 'int x = 1;\n');
            const result = await executeTool('search_in_files', { query: 'nonexistent', directory: tmpDir }, ctx);
            expect(result).to.equal('No matches found');
        });

        it('should respect glob filter', async () => {
            fs.writeFileSync(path.join(tmpDir, 'a.cpp'), 'int foo = 1;\n');
            fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'let foo = 2;\n');
            const result = await executeTool('search_in_files', { query: 'foo', directory: tmpDir, glob: '*.cpp' }, ctx);
            expect(result).to.include('a.cpp');
            expect(result).not.to.include('b.ts');
        });
    });

    describe('apply_patch', () => {
        it('should apply patch successfully', async () => {
            const filePath = path.join(tmpDir, 'test.cpp');
            fs.writeFileSync(filePath, 'int a = 1;\nint b = 2;\nint c = 3;\n');
            const result = await executeTool('apply_patch', {
                path: filePath,
                patch: 'int b = 2;\n->\nint b = 20;\n---\nint c = 3;\n->\nint c = 30;',
            }, ctx);
            expect(result).to.include('Success: Applied 2 replacement(s)');
            const updated = fs.readFileSync(filePath, 'utf-8');
            expect(updated).to.equal('int a = 1;\nint b = 20;\nint c = 30;\n');
        });

        it('should return error when line not found', async () => {
            const filePath = path.join(tmpDir, 'test.cpp');
            fs.writeFileSync(filePath, 'int a = 1;\n');
            const result = await executeTool('apply_patch', {
                path: filePath,
                patch: 'nonexistent line\n->\nint b = 2;',
            }, ctx);
            expect(result).to.include('Error:');
            expect(result).to.include('Line not found');
        });
    });

    describe('get_workspace_info', () => {
        it('should return workspaceRoot and hasDiagnostics', async () => {
            const diagCtx: ToolContext = {
                workspaceRoot: '/tmp/ws',
                diagnostics: [{ errorType: 'OUT_OF_BOUNDS' }],
            };
            const result = await executeTool('get_workspace_info', {}, diagCtx);
            const parsed = JSON.parse(result);
            expect(parsed.workspaceRoot).to.equal('/tmp/ws');
            expect(parsed.hasDiagnostics).to.equal(true);
        });
    });
});
