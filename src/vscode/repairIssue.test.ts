import { expect } from 'chai';
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeFixIssueRequest, repairIssueFromSanitizerDiagnostic } from './repairIssue';
import { AddressSpace, BlockType, MemErrorType, Severity } from '../parser/types';

describe('repairIssue', () => {
    describe('normalizeFixIssueRequest', () => {
        it('accepts VS Code URI and Range inputs', () => {
            const result = normalizeFixIssueRequest({
                uri: vscode.Uri.file('/workspace/kernel.cpp'),
                range: new vscode.Range(9, 4, 9, 18),
                issueType: 'ILLEGAL_ADDR_READ',
                message: 'read uses an invalid GM address',
                severity: vscode.DiagnosticSeverity.Error,
                details: {
                    address: '0xABC',
                    addressSpace: 'GM',
                    byteSize: 16,
                    kernelName: 'KernelA',
                    stack: [{ file: '/workspace/kernel.cpp', line: 10, column: 5 }],
                },
            });

            expect(result.ok).to.equal(true);
            if (!result.ok) {
                return;
            }
            expect(result.issue).to.include({
                fileName: path.normalize('/workspace/kernel.cpp'),
                lineNumber: 10,
                issueType: 'ILLEGAL_ADDR_READ',
                errorType: 'ILLEGAL_ADDR_READ',
                message: 'read uses an invalid GM address',
                severity: Severity.ERROR,
                address: '0xABC',
                addressSpace: 'GM',
                byteSize: 16,
                kernelName: 'KernelA',
            });
            expect(result.issue.range).to.deep.equal({
                startLine: 10,
                startCharacter: 4,
                endLine: 10,
                endCharacter: 18,
            });
            expect(result.issue.callStack).to.deep.equal([
                { file: '/workspace/kernel.cpp', line: 10, column: 5 },
            ]);
        });

        it('accepts plain object ranges and omits absent optional details', () => {
            const result = normalizeFixIssueRequest({
                uri: '/workspace/kernel.cpp',
                range: {
                    start: { line: 2, character: 0 },
                    end: { line: 2, character: 7 },
                },
                issueType: 'MSSANITIZER_ISSUE',
                message: 'caller-owned issue',
            });

            expect(result.ok).to.equal(true);
            if (!result.ok) {
                return;
            }
            expect(result.issue.severity).to.equal(Severity.ERROR);
            expect(result.issue.address).to.be.undefined;
            expect(result.issue.byteSize).to.be.undefined;
            expect(result.issue.callStack).to.be.undefined;
            expect(result.issue.rawLines).to.deep.equal(['caller-owned issue']);
        });

        it('rejects missing required fields', () => {
            const result = normalizeFixIssueRequest({
                uri: '/workspace/kernel.cpp',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                message: 'missing issue type',
            });

            expect(result.ok).to.equal(false);
            if (result.ok) {
                return;
            }
            expect(result.error).to.include('issueType');
        });
    });

    describe('repairIssueFromSanitizerDiagnostic', () => {
        it('maps parsed log diagnostics into repair issues', () => {
            const result = repairIssueFromSanitizerDiagnostic({
                errorType: MemErrorType.OUT_OF_BOUNDS,
                severity: Severity.ERROR,
                fileName: '/workspace/test.cpp',
                lineNumber: 3,
                serialNo: 1,
                address: '0x1000',
                addressSpace: AddressSpace.GM,
                byteSize: 4,
                blockInfo: { blockType: BlockType.AICORE, coreId: 0 },
                deviceId: 0,
                kernelName: 'KernelB',
                rawLines: ['raw diagnostic'],
            });

            expect(result).to.include({
                issueType: 'OUT_OF_BOUNDS',
                errorType: 'OUT_OF_BOUNDS',
                fileName: '/workspace/test.cpp',
                lineNumber: 3,
                message: 'OUT_OF_BOUNDS: 4 bytes at GM',
                kernelName: 'KernelB',
            });
        });
    });
});
