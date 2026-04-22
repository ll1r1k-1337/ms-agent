import * as path from 'path';
import * as fs from 'fs';
import { FixBackend, FixCallbacks, FixContext, FixResult } from './fixBackend';
import { SanitizerDiagnostic } from '../parser/types';
import { buildFixPrompt } from '../skills/skillLoader';
import { getLLMConfig } from '../llm/config';
import { createTransport, OpenCodeTransportConfig } from './opencodeTransport';
import { OpenCodeSession, OpenCodeSessionCallbacks } from './opencodeSession';

function resolveFilePath(fileName: string, workspaceRoot: string): string {
    if (path.isAbsolute(fileName) && fs.existsSync(fileName)) {
        return fileName;
    }
    return path.resolve(workspaceRoot, fileName);
}

function buildOpenCodePrompt(diagnostic: SanitizerDiagnostic, fileContent: string): string {
    const fixPrompt = buildFixPrompt(diagnostic);

    return `${fixPrompt}

## Source File Content

The following is the COMPLETE content of the file that needs to be fixed.
File path: ${diagnostic.fileName}

\`\`\`cpp
${fileContent}
\`\`\`

## Your Task

1. Analyze the memory error described above in the source file
2. Identify the root cause of the error at line ${diagnostic.lineNumber}
3. Apply a MINIMAL fix that resolves the issue
4. Return the COMPLETE fixed file content inside a markdown code block
5. Do NOT make unnecessary changes to other parts of the code
6. Preserve the original file structure and formatting as much as possible

## Response Format

Please return ONLY the complete fixed file content wrapped in a markdown code block like this:

\`\`\`cpp
// ... complete fixed file content ...
\`\`\`

Do not include explanations outside the code block. The code block should contain the ENTIRE file content, ready to be written directly to the file.`;
}

export class OpenCodeFixBackend implements FixBackend {
    readonly name = 'opencode';
    private session: OpenCodeSession | undefined;

    supportsStreaming(): boolean {
        return true;
    }

    cancel(): void {
        this.session?.cancel();
    }

    async executeFix(
        diagnostic: SanitizerDiagnostic,
        context: FixContext,
        callbacks?: FixCallbacks,
    ): Promise<FixResult> {
        const config = getLLMConfig();
        const workspaceRoot = context.workspaceRoot;
        const resolvedPath = resolveFilePath(diagnostic.fileName, workspaceRoot);

        if (!fs.existsSync(resolvedPath)) {
            return {
                success: false,
                finalMessage: `File not found: ${resolvedPath}`,
                toolCallCount: 0,
                fileChanged: false,
            };
        }

        const originalContent = fs.readFileSync(resolvedPath, 'utf-8');
        const prompt = buildOpenCodePrompt(diagnostic, originalContent);

        const transportConfig: OpenCodeTransportConfig = {
            mode: (config.opencodeMode || 'cli') as 'cli' | 'serve' | 'api',
            cliPath: config.opencodeCliPath,
            servePort: config.opencodeServePort,
            apiEndpoint: config.opencodeApiEndpoint,
            apiKey: config.opencodeApiKey,
            timeoutMs: config.timeoutMs,
        };

        const transport = createTransport(transportConfig);
        this.session = new OpenCodeSession(transport, callbacks as OpenCodeSessionCallbacks);

        try {
            return await this.session.run({
                prompt,
                workspaceRoot,
                resolvedPath,
                originalContent,
                timeoutMs: config.timeoutMs,
            });
        } finally {
            transport.dispose();
        }
    }
}
