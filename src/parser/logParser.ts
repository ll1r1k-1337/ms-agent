import * as fs from 'fs';
import * as path from 'path';
import {
    MemErrorType, AddressSpace, BlockType, Severity,
    SanitizerDiagnostic, ParseResult
} from './types';
export { ParseResult, parseLog, parseLogFile };

const HEADER_RE = /^====== (ERROR|WARNING): (.+)$/;
const DETAIL_RE = /^======    (.+)$/;
const LEAK_HEADER_RE = /^======    (Direct leak|WARNING: Unused memory) (.+)$/;
const ADDRESS_RE = /at (0x[0-9a-fA-F]+)/;
const SPACE_RE = /on (GM|UB|L1|L0A|L0B|L0C)/;
const KERNEL_RE = /in (\S+)$/;
const BLOCK_RE = /in block (\w+)\((\d+)\)/;
const DEVICE_RE = /on device (\d+)/;
const SERIAL_RE = /\(serialNo:(\d+)\)/;
const SIZE_RE = /(?:of size|of) (\d+)/;
const THREAD_RE = /by thread \((\d+),(\d+),(\d+)\)/;
const MODULE_RE = /by module (\d+)/;
const FILELINE_RE = /(?:code in|allocated in)\s+([^:(\s]+):(\d+)/;
const STACK_RE = /#(\d+)\s+([^:]+):(\d+)(?::(\d+))?/;
const PC_RE = /pc current (0x[0-9a-fA-F]+)/;

function isMemoryError(header: string, severity: string): boolean {
    const h = header.toLowerCase();
    if (h.includes('illegal read')) return true;
    if (h.includes('illegal write')) return true;
    if (h.includes('illegal free')) return true;
    if (h.includes('misaligned access')) return true;
    if (h.includes('uninitialized read')) return true;
    if (h.includes('out of bounds')) return true;
    if (h.includes('unused memory')) return true;
    if (h.includes('direct leak')) return true;
    return false;
}

function parseAddressSpace(text: string): AddressSpace {
    for (const space of Object.values(AddressSpace)) {
        if (text.includes(`on ${space}`)) {
            return space as AddressSpace;
        }
    }
    return AddressSpace.GM;
}

function parseBlockType(text: string): { type: BlockType; coreId: number } {
    const blockMatch = text.match(BLOCK_RE);
    if (blockMatch) {
        const raw = blockMatch[1].toLowerCase();
        let type = BlockType.AICORE;
        if (raw.includes('aiv')) { type = BlockType.AIV; }
        else if (raw.includes('aic(') || raw === 'aic') { type = BlockType.AIC; }
        return { type, coreId: parseInt(blockMatch[2], 10) };
    }
    return { type: BlockType.AICORE, coreId: 0 };
}

function parseFileSize(text: string): number {
    const m = text.match(SIZE_RE);
    return m ? parseInt(m[1], 10) : 0;
}

function classifyError(header: string): { errorType: MemErrorType; severity: Severity } {
    const h = header.toLowerCase();
    if (h.includes('illegal read') || h.includes('illegal read of size')) {
        return { errorType: MemErrorType.ILLEGAL_ADDR_READ, severity: Severity.ERROR };
    }
    if (h.includes('illegal write') || h.includes('illegal write of size')) {
        return { errorType: MemErrorType.ILLEGAL_ADDR_WRITE, severity: Severity.ERROR };
    }
    if (h.includes('out of bounds')) {
        return { errorType: MemErrorType.OUT_OF_BOUNDS, severity: Severity.WARNING };
    }
    if (h.includes('misaligned access')) {
        return { errorType: MemErrorType.MISALIGNED_ACCESS, severity: Severity.ERROR };
    }
    if (h.includes('illegal free')) {
        return { errorType: MemErrorType.ILLEGAL_FREE, severity: Severity.ERROR };
    }
    if (h.includes('uninitialized read')) {
        return { errorType: MemErrorType.UNINITIALIZED_READ, severity: Severity.ERROR };
    }
    if (h.includes('unused memory')) {
        return { errorType: MemErrorType.MEM_UNUSED, severity: Severity.WARNING };
    }
    if (h.includes('direct leak')) {
        return { errorType: MemErrorType.MEM_LEAK, severity: Severity.ERROR };
    }
    return { errorType: MemErrorType.ILLEGAL_ADDR_READ, severity: Severity.ERROR };
}

interface RawGroup {
    header: string;
    severity: string;
    lines: string[];
    isLeakOrUnused: boolean;
}

function groupLines(content: string): RawGroup[] {
    const lines = content.split('\n');
    const groups: RawGroup[] = [];
    let current: RawGroup | null = null;

    for (const line of lines) {
        // Skip obviously binary lines containing null byte
        if (line.includes('\0')) continue;
        const headerMatch = line.match(HEADER_RE);
        if (headerMatch) {
            if (isMemoryError(headerMatch[2], headerMatch[1])) {
                current = {
                    header: headerMatch[2],
                    severity: headerMatch[1],
                    lines: [line],
                    isLeakOrUnused: false
                };
                groups.push(current);
                continue;
            }
            current = null;
            continue;
        }

        const leakMatch = line.match(LEAK_HEADER_RE);
        // Always start a new group for leak/unused headers (do not require !current:
        // otherwise a leak after another diagnostic is dropped, e.g. mixed_errors.log).
        if (leakMatch) {
            current = {
                header: leakMatch[1] + ' ' + leakMatch[2],
                severity: leakMatch[1] === 'Direct leak' ? 'ERROR' : 'WARNING',
                lines: [line],
                isLeakOrUnused: true
            };
            groups.push(current);
            continue;
        }

        const detailMatch = line.match(DETAIL_RE);
        if (detailMatch && current) {
            current.lines.push(line);
        } else if (!line.match(/^======/) && !line.match(/^\[mssanitizer\]/) && line.trim()) {
            if (line.startsWith('======')) {
                continue;
            }
        }
    }

    return groups;
}

function parseGroup(group: RawGroup): SanitizerDiagnostic | null {
    const fullText = group.lines.join('\n');

    if (group.isLeakOrUnused) {
        return parseLeakOrUnused(group, fullText);
    }

    const { errorType, severity } = classifyError(group.header);
    const address = extractStr(ADDRESS_RE, fullText, '0x0');
    const addressSpace = parseAddressSpace(fullText);
    const byteSize = parseFileSize(group.header);
    const block = parseBlockType(fullText);
    const deviceId = extractInt(DEVICE_RE, fullText, 0);
    const serialNo = extractInt(SERIAL_RE, fullText, 0);

    const threadMatch = fullText.match(THREAD_RE);
    const threadLocation = threadMatch ? {
        idX: parseInt(threadMatch[1], 10),
        idY: parseInt(threadMatch[2], 10),
        idZ: parseInt(threadMatch[3], 10),
    } : undefined;

    const pcMatch = fullText.match(PC_RE);
    const pc = pcMatch ? pcMatch[1] : undefined;

    const kernelMatch = fullText.match(KERNEL_RE);
    const kernelName = kernelMatch && !kernelMatch[1].match(/^(aicore|aiv|aic)\(/)
        ? kernelMatch[1]
        : undefined;

    const fileLineMatch = fullText.match(FILELINE_RE);
    let fileName = 'unknown';
    let lineNumber = 0;
    const callStack: { file: string; line: number; column?: number }[] = [];

    for (const line of group.lines) {
        const stackMatch = line.match(STACK_RE);
        if (stackMatch) {
            callStack.push({
                file: stackMatch[2].trim(),
                line: parseInt(stackMatch[3], 10),
                column: stackMatch[4] ? parseInt(stackMatch[4], 10) : undefined,
            });
        }
    }

    if (callStack.length > 0) {
        fileName = callStack[0].file;
        lineNumber = callStack[0].line;
    } else if (fileLineMatch) {
        fileName = fileLineMatch[1].trim();
        lineNumber = parseInt(fileLineMatch[2], 10);
    }

    const moduleMatch = fullText.match(MODULE_RE);
    const moduleId = moduleMatch ? parseInt(moduleMatch[1], 10) : undefined;

    return {
        errorType,
        severity: severity as Severity,
        fileName,
        lineNumber,
        serialNo,
        address,
        addressSpace,
        byteSize,
        blockInfo: { blockType: block.type, coreId: block.coreId },
        deviceId,
        kernelName,
        threadLocation,
        pc,
        callStack: callStack.length > 0 ? callStack : undefined,
        moduleId,
        rawLines: group.lines,
    };
}

function parseLeakOrUnused(group: RawGroup, fullText: string): SanitizerDiagnostic | null {
    const isLeak = fullText.includes('Direct leak');
    const isUnused = fullText.includes('Unused memory');

    const byteSize = parseFileSize(fullText);
    const address = extractStr(ADDRESS_RE, fullText, '0x0');
    const addressSpace = AddressSpace.GM;

    const moduleMatch = fullText.match(MODULE_RE);
    const moduleId = moduleMatch ? parseInt(moduleMatch[1], 10) : undefined;
    const serialNo = extractInt(SERIAL_RE, fullText, 0);

    const fileLineMatch = fullText.match(FILELINE_RE);
    let fileName = 'unknown';
    let lineNumber = 0;

    if (fileLineMatch) {
        fileName = fileLineMatch[1].trim();
        lineNumber = parseInt(fileLineMatch[2], 10);
    }

    let errorType: MemErrorType;
    if (isLeak) {
        errorType = MemErrorType.MEM_LEAK;
    } else if (isUnused) {
        errorType = MemErrorType.MEM_UNUSED;
    } else {
        return null;
    }

    return {
        errorType,
        severity: isLeak ? Severity.ERROR : Severity.WARNING,
        fileName,
        lineNumber,
        serialNo,
        address,
        addressSpace,
        byteSize,
        blockInfo: { blockType: BlockType.AICORE, coreId: 0 },
        deviceId: 0,
        moduleId,
        rawLines: group.lines,
    };
}

function extractStr(re: RegExp, text: string, fallback: string): string {
    const m = text.match(re);
    return m ? m[1] : fallback;
}

function extractInt(re: RegExp, text: string, fallback: number): number {
    const m = text.match(re);
    return m ? parseInt(m[1], 10) : fallback;
}

function parseLog(logContent: string): ParseResult {
    // Handle completely empty/whitespace-only content gracefully
    if (!logContent || logContent.trim().length === 0) {
        return { diagnostics: [], parseErrors: [] };
    }
    const groups = groupLines(logContent);
    const diagnostics: SanitizerDiagnostic[] = [];
    const parseErrors: string[] = [];

    for (const group of groups) {
        try {
            const diag = parseGroup(group);
            if (diag) {
                diagnostics.push(diag);
            }
        } catch (e) {
            parseErrors.push(`Failed to parse group starting with: ${group.lines[0]?.substring(0, 80)}`);
        }
    }

    return { diagnostics, parseErrors };
}

function parseLogFile(filePath: string): ParseResult {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return parseLog(content);
    } catch (err: any) {
        if (err && err.code === 'ENOENT') {
            return { diagnostics: [], parseErrors: ['File not found: ' + filePath] };
        }
        return { diagnostics: [], parseErrors: ['Failed to read file: ' + filePath] };
    }
}
