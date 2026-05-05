import * as path from 'path';
import * as fs from 'fs';
import { FixBackend, FixCallbacks, FixContext, FixResult } from './fixBackend';
import { MemErrorType, SanitizerDiagnostic } from '../parser/types';
import { buildFixPrompt, loadSkill } from '../skills/skillLoader';
import { getLLMConfig } from '../llm/config';
import { createTransport, OpenCodeTransport, OpenCodeTransportConfig, TransportLogger } from './opencodeTransport';
import { OpenCodeSession, OpenCodeSessionCallbacks } from './opencodeSession';

export type OpenCodeTransportFactory = (
    config: OpenCodeTransportConfig,
    logger?: TransportLogger,
) => OpenCodeTransport;

function getOutputChannel(): { appendLine: (msg: string) => void } {
    const globalAny = global as any;
    if (globalAny.msAgentOutputChannel) {
        return globalAny.msAgentOutputChannel;
    }
    return { appendLine: (msg: string) => console.log('[OpenCodeBackend]', msg) };
}

function log(msg: string): void {
    getOutputChannel().appendLine(`[OpenCodeBackend] ${msg}`);
}

function resolveFilePath(fileName: string, workspaceRoot: string): string {
    if (path.isAbsolute(fileName) && fs.existsSync(fileName)) {
        return fileName;
    }
    return path.resolve(workspaceRoot, fileName);
}

function buildFocusedSnippet(fileContent: string, lineNumber: number, radius = 5): string {
    const lines = fileContent.split(/\r?\n/);
    const targetIndex = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
    const start = Math.max(0, targetIndex - radius);
    const end = Math.min(lines.length - 1, targetIndex + radius);
    const snippet: string[] = [];
    for (let i = start; i <= end; i += 1) {
        const marker = i === targetIndex ? '>' : ' ';
        snippet.push(`${marker} ${String(i + 1).padStart(4, ' ')} | ${lines[i]}`);
    }
    return snippet.join('\n');
}

function getLine(fileContent: string, lineNumber: number): string {
    const lines = fileContent.split(/\r?\n/);
    const index = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
    return lines[index] || '';
}

function buildTargetedRepairHint(diagnostic: SanitizerDiagnostic, fileContent: string): string {
    const targetLine = getLine(fileContent, diagnostic.lineNumber).trim();
    if (
        diagnostic.errorType === MemErrorType.OUT_OF_BOUNDS
        && /\bDataCopy\s*\(/.test(targetLine)
    ) {
        const tileLengthHint = /2\s*\*\s*TILE_LENGTH|TILE_LENGTH\s*\*\s*2/.test(targetLine)
            ? '\n- In this fixture pattern, a local buffer initialized with TILE_LENGTH capacity must not be copied with 2 * TILE_LENGTH; the minimal safe edit is usually to change the third DataCopy argument to TILE_LENGTH.'
            : '';
        return `\n## Targeted Repair Hint\n\nThe reported OUT_OF_BOUNDS is on this exact line:\n\n\`\`\`cpp\n${targetLine}\n\`\`\`\n\nFor DataCopy(dst, src, size), fix the size expression at this diagnostic line only unless the surrounding capacity calculation proves a different one-line bound is required.${tileLengthHint}\n`;
    }
    return '';
}

function buildOpenCodePrompt(diagnostic: SanitizerDiagnostic, fileContent: string): string {
    const fixPrompt = buildFixPrompt(diagnostic);
    const skillContent = loadSkill('memcheck-skills') || '';
    const focusedSnippet = buildFocusedSnippet(fileContent, diagnostic.lineNumber);
    const targetedRepairHint = buildTargetedRepairHint(diagnostic, fileContent);

    let prompt = `${fixPrompt}`;
    if (skillContent) {
        prompt += '\n\n## Additional Context\n' + skillContent;
    }

    return `${prompt}

## Source File (for reference)

File path: ${diagnostic.fileName}
Error at line ${diagnostic.lineNumber}.

\`\`\`cpp
${fileContent}
\`\`\`

## Focused Snippet

The target line is marked with \`>\`.

\`\`\`text
${focusedSnippet}
\`\`\`
${targetedRepairHint}

## How to apply the fix

Use OpenCode's native tools available in this session to apply a MINIMAL patch
at the error location. If OpenCode exposes the relevant capability as a skill,
use that skill instead of echoing file contents manually.

Required behavior:
1. Analyze the memory error described above.
2. Identify the root cause at line ${diagnostic.lineNumber}.
3. Use OpenCode's native edit capability to change ONLY the diagnostic target line unless an adjacent bound variable is strictly necessary.
4. Preserve all other code, comments, whitespace, and formatting exactly.
5. Do NOT describe a plan, verification steps, or what you are about to do before editing. Your first assistant response must be a native tool action, or a terminal marker if no edit is needed.
6. If the code is already correct or no safe code change is needed, respond with a single line:
   \`NO_FIX_NEEDED: <short reason>\`
7. If you apply an edit, send a short explanation using this exact structure AFTER the native edit succeeds:
   \`Problem: <why the diagnostic happened>\`
   \`Fix: <the exact code change you made>\`
   \`Why it works: <why the new bound / edit is safe>\`
   You may add \`Notes: <short caveat>\` only if needed.

Do NOT:
- Echo the whole file back as a code block. Use the edit tool instead.
- Return a standalone C/C++ code block as the fix; msAgent will preserve the original file unless OpenCode edits the file on disk.
- Fix other BUG comments or nearby sanitizer issues that are not the diagnostic at line ${diagnostic.lineNumber}.
- Emit placeholder text like "rest of file unchanged" or "..." in any output.
- Rewrite large regions just to tidy them up.
- Reply with only "fixed", "applied", or another unstructured confirmation after editing.
- Emit process narration such as "I'll inspect the file", "I'll verify the patch", or "First I'll read the surrounding lines".

If you determine you cannot safely fix the error (e.g. missing context, unclear
intent), respond with a single line of the exact form:

\`CANNOT_FIX: <short reason>\`

and make no edits. Do not wrap either terminal marker line in a code block.`;
}

function buildRetryPrompt(prompt: string, diagnostic: SanitizerDiagnostic, previousMessage: string): string {
    return `${prompt}

## Retry Instruction

The previous OpenCode attempt finished without a native file edit:

${previousMessage}

Try once more, but follow this stricter contract:
- You MUST use OpenCode's native edit capability to modify the target file on disk.
- The edit MUST be minimal and focused on line ${diagnostic.lineNumber}.
- Your first assistant response MUST be the native edit action or a terminal marker; do not emit planning prose first.
- Do NOT answer with a code block, diff block, or prose-only "fixed" message.
- After a successful native edit, explain the result using \`Problem:\`, \`Fix:\`, and \`Why it works:\`.
- Do NOT emit process narration like "I will verify the patch" or "Let me inspect the file first".
- If a native edit is not available, return exactly \`CANNOT_FIX: native edit tool unavailable\`.
- If the code is already correct, return exactly \`NO_FIX_NEEDED: <short reason>\`.`;
}

function isRetryableNoEditResult(result: FixResult): boolean {
    if (result.success || result.fileChanged || result.outcome === 'no_change') {
        return false;
    }

    const message = result.finalMessage.toLowerCase();
    const nonRetryableMarkers = [
        'fix cancelled by user',
        'transport error',
        'timed out',
        'quota',
        'usage limit',
        'api key',
        'provider/model',
        'tool failed',
        'file not found',
        'transport closed before hard terminal event',
        'opencode server did not return',
    ];
    if (nonRetryableMarkers.some((marker) => message.includes(marker))) {
        return false;
    }

    return [
        'did not modify the file',
        'did not provide a parseable reason',
        'returned the original code without explaining why',
        'code block instead of applying an edit tool',
        'placeholder or truncated response',
    ].some((marker) => message.includes(marker));
}

function buildTransportConfig(config: ReturnType<typeof getLLMConfig>, workspaceRoot?: string): OpenCodeTransportConfig {
    return {
        cliPath: config.opencodeCliPath,
        servePort: config.opencodeServePort,
        apiKey: config.opencodeApiKey,
        timeoutMs: config.timeoutMs,
        model: config.modelID,
        providerID: config.providerID,
        modelFullName: config.modelFullName,
        workspaceRoot,
    };
}

export class OpenCodeFixBackend implements FixBackend {
    readonly name = 'opencode';
    private session: OpenCodeSession | undefined;
    private lastTransportConfig: OpenCodeTransportConfig | undefined;
    private readonly createTransportOverride?: OpenCodeTransportFactory;

    constructor(createTransportOverride?: OpenCodeTransportFactory) {
        this.createTransportOverride = createTransportOverride;
    }

    supportsStreaming(): boolean {
        return true;
    }

    cancel(): void {
        this.session?.cancel();
    }

    getServerPort(): number | undefined {
        return this.lastTransportConfig?.servePort;
    }

    getTransportMode(): string | undefined {
        return this.lastTransportConfig ? 'server' : undefined;
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
                outcome: 'failed',
                finalMessage: `File not found: ${resolvedPath}`,
                toolCallCount: 0,
                fileChanged: false,
            };
        }

        const originalContent = fs.readFileSync(resolvedPath, 'utf-8');
        const prompt = buildOpenCodePrompt(diagnostic, originalContent);
        const primaryTransportConfig = buildTransportConfig(config, workspaceRoot);
        this.lastTransportConfig = primaryTransportConfig;
        log(`executeFix mode=server model=${primaryTransportConfig.modelFullName || primaryTransportConfig.model || 'default'} file=${resolvedPath}`);

        let bufferedFirstSessionEnd: unknown;
        const firstAttemptCallbacks: FixCallbacks | undefined = callbacks
            ? {
                ...callbacks,
                onEvent: (type, payload) => {
                    if (type === 'session_end') {
                        bufferedFirstSessionEnd = payload;
                        return;
                    }
                    callbacks.onEvent?.(type, payload);
                },
            }
            : undefined;

        let firstResult: FixResult;
        try {
            firstResult = await this.runWithTransport(
                primaryTransportConfig,
                prompt,
                workspaceRoot,
                resolvedPath,
                originalContent,
                config.timeoutMs,
                firstAttemptCallbacks,
            );
        } catch (error) {
            if (bufferedFirstSessionEnd !== undefined) {
                callbacks?.onEvent?.('session_end', bufferedFirstSessionEnd);
            }
            throw error;
        }

        if (!isRetryableNoEditResult(firstResult)) {
            if (bufferedFirstSessionEnd !== undefined) {
                callbacks?.onEvent?.('session_end', bufferedFirstSessionEnd);
            }
            return firstResult;
        }

        callbacks?.onEvent?.('status', {
            phase: 'running',
            message: 'OpenCode produced no native edit; retrying once with stricter edit-tool instructions...',
        });
        log(`retrying no-edit OpenCode result file=${resolvedPath} reason=${firstResult.finalMessage}`);
        const retryPrompt = buildRetryPrompt(prompt, diagnostic, firstResult.finalMessage);

        return await this.runWithTransport(
            primaryTransportConfig,
            retryPrompt,
            workspaceRoot,
            resolvedPath,
            originalContent,
            config.timeoutMs,
            callbacks,
        );
    }

    private async runWithTransport(
        transportConfig: OpenCodeTransportConfig,
        prompt: string,
        workspaceRoot: string,
        resolvedPath: string,
        originalContent: string,
        timeoutMs: number,
        callbacks?: FixCallbacks,
    ): Promise<FixResult> {
        log('starting transport mode=server');
        callbacks?.onEvent?.('status', {
            phase: 'connecting',
            message: `Starting OpenCode server on port ${transportConfig.servePort}...`,
        });

        const factory = this.createTransportOverride ?? createTransport;
        const transport = factory(transportConfig, log);
        this.session = new OpenCodeSession(transport, callbacks as OpenCodeSessionCallbacks);

        try {
            return await this.session.run({
                prompt,
                workspaceRoot,
                resolvedPath,
                originalContent,
                timeoutMs,
                mode: 'server',
                model: transportConfig.modelFullName,
            });
        } finally {
            log('disposing transport mode=server');
            transport.dispose();
        }
    }
}
