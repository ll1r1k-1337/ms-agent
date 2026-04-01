/** Memory error types detected by ms-agent memcheck */
export enum MemErrorType {
    OUT_OF_BOUNDS = 'OUT_OF_BOUNDS',
    ILLEGAL_ADDR_WRITE = 'ILLEGAL_ADDR_WRITE',
    ILLEGAL_ADDR_READ = 'ILLEGAL_ADDR_READ',
    MISALIGNED_ACCESS = 'MISALIGNED_ACCESS',
    MEM_LEAK = 'MEM_LEAK',
    ILLEGAL_FREE = 'ILLEGAL_FREE',
    MEM_UNUSED = 'MEM_UNUSED',
    UNINITIALIZED_READ = 'UNINITIALIZED_READ',
}

/** Memory address spaces in Ascend NPU */
export enum AddressSpace {
    GM = 'GM',
    UB = 'UB',
    L1 = 'L1',
    L0A = 'L0A',
    L0B = 'L0B',
    L0C = 'L0C',
}

/** Block types in Ascend NPU */
export enum BlockType {
    AICORE = 'aicore',
    AIV = 'aiv',
    AIC = 'aic',
}

/** Severity levels for diagnostics */
export enum Severity {
    ERROR = 'Error',
    WARNING = 'Warning',
}

/** Thread location for SIMT errors */
export interface ThreadLocation {
    idX: number;
    idY: number;
    idZ: number;
}

/** Call stack frame */
export interface StackFrame {
    file: string;
    line: number;
    column?: number;
}

/** Block information */
export interface BlockInfo {
    blockType: BlockType;
    coreId: number;
}

/** A single ms-agent diagnostic */
export interface SanitizerDiagnostic {
    /** The type of memory error */
    errorType: MemErrorType;
    /** Severity: ERROR or WARNING */
    severity: Severity;
    /** Source file where the error occurred */
    fileName: string;
    /** Source line number (1-based) */
    lineNumber: number;
    /** Serial number of the operation */
    serialNo: number;
    /** Faulty memory address (hex string) */
    address: string;
    /** Address space where error occurred */
    addressSpace: AddressSpace;
    /** Number of bytes involved */
    byteSize: number;
    /** Block information */
    blockInfo: BlockInfo;
    /** Device ID */
    deviceId: number;
    /** Kernel name (if kernel-side error) */
    kernelName?: string;
    /** Thread location (for SIMT errors) */
    threadLocation?: ThreadLocation;
    /** Program counter */
    pc?: string;
    /** Call stack */
    callStack?: StackFrame[];
    /** Module ID (for memory leak) */
    moduleId?: number;
    /** Raw text lines for reference */
    rawLines: string[];
}

/** Result of parsing a log file */
export interface ParseResult {
    diagnostics: SanitizerDiagnostic[];
    parseErrors: string[];
}
