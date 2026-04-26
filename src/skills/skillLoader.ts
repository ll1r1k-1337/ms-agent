import * as fs from 'fs';
import * as path from 'path';

export function loadSkill(skillName: string): string | null {
    const skillsDir = path.join(__dirname, '..', 'skills');
    const filePath = path.join(skillsDir, `${skillName}.md`);
    if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
    }
    return null;
}

export function buildFixPrompt(diagnostic: {
    errorType: string;
    severity: string;
    fileName: string;
    lineNumber: number;
    address: string;
    addressSpace: string;
    byteSize: number;
    kernelName?: string;
}): string {
    return `You are an expert at fixing Ascend NPU operator memory errors detected by ms-agent.

## Error to Fix
- **Type**: ${diagnostic.errorType}
- **Severity**: ${diagnostic.severity}
- **File**: ${diagnostic.fileName}:${diagnostic.lineNumber}
- **Address**: ${diagnostic.address} on ${diagnostic.addressSpace}
- **Size**: ${diagnostic.byteSize} bytes
${diagnostic.kernelName ? `- **Kernel**: ${diagnostic.kernelName}` : ''}

## Instructions
1. Read the file with OpenCode's native file/context tools to understand the surrounding code context
2. Identify the root cause of the memory error
3. Apply a minimal native edit that addresses the root cause
4. Explain what was wrong and how your fix resolves it
5. Do NOT make unnecessary changes to surrounding code
6. If the error requires understanding the full file, inspect it first before making edits`;
}
