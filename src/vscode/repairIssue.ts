import * as path from 'path';
import * as vscode from 'vscode';
import { SanitizerDiagnostic, Severity, StackFrame } from '../parser/types';

export interface RepairRange {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
}

export interface RepairIssue {
    issueType: string;
    errorType: string;
    severity: Severity;
    fileName: string;
    lineNumber: number;
    range?: RepairRange;
    message: string;
    address?: string;
    addressSpace?: string;
    byteSize?: number;
    kernelName?: string;
    callStack?: StackFrame[];
    rawLines: string[];
}

export interface MsAgentFixIssueRequest {
    uri: string | vscode.Uri;
    range: vscode.Range | {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    issueType: string;
    message: string;
    severity?: 'Error' | 'Warning' | vscode.DiagnosticSeverity;
    details?: {
        address?: string;
        addressSpace?: string;
        byteSize?: number;
        kernelName?: string;
        stack?: Array<{ file: string; line: number; column?: number }>;
    };
}

export type NormalizeFixIssueResult =
    | { ok: true; issue: RepairIssue }
    | { ok: false; error: string };

function nonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUriToFsPath(value: unknown): string | undefined {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return undefined;
        }
        if (/^file:/i.test(trimmed)) {
            try {
                return path.normalize(vscode.Uri.parse(trimmed).fsPath);
            } catch {
                return undefined;
            }
        }
        return path.normalize(trimmed);
    }

    if (value && typeof value === 'object') {
        const fsPath = (value as { fsPath?: unknown }).fsPath;
        if (typeof fsPath === 'string' && fsPath.trim()) {
            return path.normalize(fsPath);
        }
    }

    return undefined;
}

function normalizeSeverity(value: unknown): Severity | undefined {
    if (value === undefined || value === null) {
        return Severity.ERROR;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'error') {
            return Severity.ERROR;
        }
        if (normalized === 'warning') {
            return Severity.WARNING;
        }
        return undefined;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value === vscode.DiagnosticSeverity.Error
            ? Severity.ERROR
            : Severity.WARNING;
    }
    return undefined;
}

function readPosition(value: unknown): { line: number; character: number } | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const record = value as { line?: unknown; character?: unknown };
    if (
        typeof record.line !== 'number'
        || typeof record.character !== 'number'
        || !Number.isInteger(record.line)
        || !Number.isInteger(record.character)
        || record.line < 0
        || record.character < 0
    ) {
        return undefined;
    }
    return { line: record.line, character: record.character };
}

function normalizeRange(value: unknown): RepairRange | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const record = value as { start?: unknown; end?: unknown };
    const start = readPosition(record.start);
    const end = readPosition(record.end);
    if (!start || !end) {
        return undefined;
    }
    if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
        return undefined;
    }
    return {
        startLine: start.line + 1,
        startCharacter: start.character,
        endLine: end.line + 1,
        endCharacter: end.character,
    };
}

function normalizeOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeStack(value: unknown): StackFrame[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const frames: StackFrame[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const record = item as { file?: unknown; line?: unknown; column?: unknown };
        const file = nonEmptyString(record.file);
        const line = normalizeOptionalNumber(record.line);
        if (!file || line === undefined || line < 1) {
            continue;
        }
        const column = normalizeOptionalNumber(record.column);
        frames.push({
            file,
            line,
            ...(column !== undefined ? { column } : {}),
        });
    }
    return frames.length > 0 ? frames : undefined;
}

export function repairIssueFromSanitizerDiagnostic(diagnostic: SanitizerDiagnostic): RepairIssue {
    return {
        issueType: String(diagnostic.errorType),
        errorType: String(diagnostic.errorType),
        severity: diagnostic.severity,
        fileName: diagnostic.fileName,
        lineNumber: diagnostic.lineNumber,
        message: `${diagnostic.errorType}: ${diagnostic.byteSize} bytes at ${diagnostic.addressSpace}`,
        address: diagnostic.address,
        addressSpace: diagnostic.addressSpace,
        byteSize: diagnostic.byteSize,
        kernelName: diagnostic.kernelName,
        callStack: diagnostic.callStack,
        rawLines: diagnostic.rawLines,
    };
}

export function normalizeFixIssueRequest(request: unknown): NormalizeFixIssueResult {
    if (!request || typeof request !== 'object') {
        return { ok: false, error: 'request must be an object' };
    }

    const record = request as MsAgentFixIssueRequest;
    const fileName = normalizeUriToFsPath(record.uri);
    if (!fileName) {
        return { ok: false, error: 'uri must be a file URI or path' };
    }

    const range = normalizeRange(record.range);
    if (!range) {
        return { ok: false, error: 'range must include non-negative start/end positions' };
    }

    const issueType = nonEmptyString(record.issueType);
    if (!issueType) {
        return { ok: false, error: 'issueType is required' };
    }

    const message = nonEmptyString(record.message);
    if (!message) {
        return { ok: false, error: 'message is required' };
    }

    const severity = normalizeSeverity(record.severity);
    if (!severity) {
        return { ok: false, error: 'severity must be Error, Warning, or a VS Code DiagnosticSeverity value' };
    }

    const details = record.details && typeof record.details === 'object' ? record.details : undefined;
    const stack = normalizeStack(details?.stack);
    const byteSize = normalizeOptionalNumber(details?.byteSize);

    return {
        ok: true,
        issue: {
            issueType,
            errorType: issueType,
            severity,
            fileName,
            lineNumber: range.startLine,
            range,
            message,
            address: nonEmptyString(details?.address),
            addressSpace: nonEmptyString(details?.addressSpace),
            byteSize,
            kernelName: nonEmptyString(details?.kernelName),
            callStack: stack,
            rawLines: [message],
        },
    };
}
