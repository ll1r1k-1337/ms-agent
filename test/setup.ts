import { Module } from 'module';
import * as path from 'path';

const mockPath = path.resolve(__dirname, 'vscode-mock.ts');
const originalResolveFilename = (Module as any)._resolveFilename;

(Module as any)._resolveFilename = function (request: string, parent: Module, isMain: boolean, options?: any) {
    if (request === 'vscode') {
        return mockPath;
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
};
