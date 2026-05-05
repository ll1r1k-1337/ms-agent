import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OpenCodeSession, OpenCodeSessionCallbacks, detectPlaceholderResponse } from './opencodeSession';
import { OpenCodeTransport } from './opencodeTransport';

class MockTransport implements OpenCodeTransport {
    private eventCallback?: (event: unknown) => void;
    private progressCallback?: (message: string) => void;
    private errorCallback?: (error: Error) => void;
    private closeCallback?: (exitCode: number | null) => void;
    public cancelled = false;
    public sessionMessages: unknown[] | null = null;

    onEvent(cb: (event: unknown) => void): void {
        this.eventCallback = cb;
    }

    onProgress(cb: (message: string) => void): void {
        this.progressCallback = cb;
    }

    onError(cb: (error: Error) => void): void {
        this.errorCallback = cb;
    }

    onClose(cb: (exitCode: number | null) => void): void {
        this.closeCallback = cb;
    }

    start(_prompt: string): void {}
    async readSessionMessages(): Promise<unknown[] | null> { return this.sessionMessages; }
    cancel(): void { this.cancelled = true; }
    dispose(): void {}

    emitEvent(event: unknown): void {
        this.eventCallback?.(event);
    }

    emitClose(exitCode: number | null = null): void {
        this.closeCallback?.(exitCode);
    }

    emitError(error: Error): void {
        this.errorCallback?.(error);
    }
}

describe('OpenCodeSession', () => {
    let transport: MockTransport;
    let session: OpenCodeSession;
    let tempDir: string;
    let testFilePath: string;

    const baseOptions = () => ({
        prompt: 'fix this code',
        workspaceRoot: tempDir,
        resolvedPath: testFilePath,
        originalContent: 'int main() { return 0; }',
        timeoutMs: 5000,
    });

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msagent-test-'));
        testFilePath = path.join(tempDir, 'test.cpp');
        fs.writeFileSync(testFilePath, 'int main() { return 0; }', 'utf-8');
        transport = new MockTransport();
        session = new OpenCodeSession(transport);
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('preserves the file when the model returns a code block instead of editing with tools', async () => {
        const runPromise = session.run(baseOptions());
        transport.emitEvent({ type: 'text', part: { text: '```cpp\nint main() { return 1; }\n```' } });
        transport.emitEvent({ type: 'done' });
        const result = await runPromise;

        expect(result.success).to.equal(false);
        expect(result.outcome).to.equal('failed');
        expect(result.fileChanged).to.equal(false);
        expect(result.finalMessage).to.include('code block');
        expect(fs.readFileSync(testFilePath, 'utf-8')).to.equal('int main() { return 0; }');
    });

    it('preserves the file when only a soft close arrives', async () => {
        const runPromise = session.run(baseOptions());
        transport.emitEvent({ type: 'text', part: { text: '```cpp\nint main() { return 7; }\n```' } });
        transport.emitEvent({ type: 'session.idle' });
        transport.emitClose(0);
        const result = await runPromise;

        expect(result.success).to.equal(false);
        expect(result.outcome).to.equal('failed');
        expect(result.fileChanged).to.equal(false);
        expect(fs.readFileSync(testFilePath, 'utf-8')).to.equal('int main() { return 0; }');
    });

    it('prefers native disk edits over text output when the file changed', async () => {
        const runPromise = session.run(baseOptions());
        transport.emitEvent({ type: 'text', part: { text: 'I have updated the file with my native tools.' } });
        fs.writeFileSync(testFilePath, 'int main() { return 42; }', 'utf-8');
        transport.emitEvent({ type: 'done' });
        const result = await runPromise;

        expect(result.success).to.equal(true);
        expect(result.outcome).to.equal('applied');
        expect(result.fileChanged).to.equal(true);
        expect(result.newContent).to.equal('int main() { return 42; }');
    });

    it('uses real assistant message ids and promotes only structured final explanations on success', async () => {
        const streamed: Array<{ delta: string; messageId: string }> = [];
        const callbacks: OpenCodeSessionCallbacks = {
            onMessageChunk: (chunk, currentMessageId) => {
                if (chunk.type === 'text_delta' && chunk.delta) {
                    streamed.push({ delta: chunk.delta, messageId: currentMessageId });
                }
            },
        };
        session = new OpenCodeSession(transport, callbacks);

        const runPromise = session.run(baseOptions());
        transport.emitEvent({
            type: 'message.updated',
            properties: { info: { role: 'assistant', id: 'msg_plan' } },
        });
        transport.emitEvent({
            type: 'text',
            role: 'assistant',
            messageId: 'msg_plan',
            part: {
                messageId: 'msg_plan',
                text: 'I will inspect the surrounding lines before editing.',
            },
        });
        transport.emitEvent({
            type: 'message.updated',
            properties: { info: { role: 'assistant', id: 'msg_final' } },
        });
        transport.emitEvent({
            type: 'text',
            role: 'assistant',
            messageId: 'msg_final',
            part: {
                messageId: 'msg_final',
                text: 'Problem: the copy length exceeds the local buffer.\nFix: changed the third DataCopy argument to TILE_LENGTH.\nWhy it works: the copy now matches the allocated capacity.',
            },
        });
        fs.writeFileSync(testFilePath, 'int main() { return 42; }', 'utf-8');
        transport.emitEvent({
            type: 'message.updated',
            properties: { info: { role: 'assistant', id: 'msg_final', time: { completed: 1 } } },
        });
        const result = await runPromise;

        expect(streamed.some((entry) => entry.messageId === 'msg_plan')).to.equal(true);
        expect(streamed.some((entry) => entry.messageId === 'msg_final')).to.equal(true);
        expect(result.success).to.equal(true);
        expect(result.finalMessage).to.include('Problem: the copy length exceeds the local buffer.');
        expect(result.finalMessage).to.not.include('I will inspect the surrounding lines before editing.');
        expect(result.explanationKind).to.equal('structured');
    });

    it('reads session messages for a final explanation when streaming only contained planning text', async () => {
        transport.sessionMessages = [
            {
                id: 'msg_plan',
                role: 'assistant',
                parts: [{ type: 'text', text: 'Verifying the target line before editing.' }],
            },
            {
                id: 'msg_final',
                role: 'assistant',
                parts: [{
                    type: 'text',
                    text: 'Changed the DataCopy length to TILE_LENGTH so the write fits the local buffer.',
                }],
            },
        ];

        const runPromise = session.run(baseOptions());
        transport.emitEvent({
            type: 'message.updated',
            properties: { info: { role: 'assistant', id: 'msg_plan' } },
        });
        transport.emitEvent({
            type: 'message.part.updated',
            properties: {
                part: {
                    type: 'text',
                    messageID: 'msg_plan',
                    text: 'Verifying the target line before editing.',
                },
            },
        });
        fs.writeFileSync(testFilePath, 'int main() { return 42; }', 'utf-8');
        transport.emitEvent({
            type: 'message.updated',
            properties: { info: { role: 'assistant', id: 'msg_final', time: { completed: 1 } } },
        });
        const result = await runPromise;

        expect(result.success).to.equal(true);
        expect(result.finalMessage).to.equal(
            'Changed the DataCopy length to TILE_LENGTH so the write fits the local buffer.',
        );
        expect(result.explanationKind).to.equal('plain');
    });

    it('reports explanation unavailable when the successful session contains no final explanation', async () => {
        transport.sessionMessages = [
            {
                id: 'msg_plan',
                role: 'assistant',
                parts: [{ type: 'text', text: 'Verifying the target line before editing.' }],
            },
        ];

        const runPromise = session.run(baseOptions());
        transport.emitEvent({
            type: 'message.updated',
            properties: { info: { role: 'assistant', id: 'msg_plan' } },
        });
        transport.emitEvent({
            type: 'message.part.updated',
            properties: {
                part: {
                    type: 'text',
                    messageID: 'msg_plan',
                    text: 'Verifying the target line before editing.',
                },
            },
        });
        fs.writeFileSync(testFilePath, 'int main() { return 42; }', 'utf-8');
        transport.emitEvent({
            type: 'message.updated',
            properties: { info: { role: 'assistant', id: 'msg_plan', time: { completed: 1 } } },
        });
        const result = await runPromise;

        expect(result.success).to.equal(true);
        expect(result.finalMessage).to.equal(
            'OpenCode applied the fix but did not return an explanation in this session.',
        );
        expect(result.explanationKind).to.equal('missing');
    });

    it('forwards OpenCode transport session metadata without treating it as completion', async () => {
        const events: Array<{ type: string; payload: unknown }> = [];
        session = new OpenCodeSession(transport, {
            onEvent: (type, payload) => events.push({ type, payload }),
        });

        const runPromise = session.run(baseOptions());
        transport.emitEvent({ type: 'session_start', sessionId: 'ses_metadata' });
        transport.emitEvent({ type: 'text', part: { text: 'NO_FIX_NEEDED: already bounded.' } });
        transport.emitEvent({ type: 'done' });
        const result = await runPromise;

        expect(events).to.deep.include({
            type: 'session_metadata',
            payload: { opencodeSessionId: 'ses_metadata' },
        });
        expect(result.outcome).to.equal('no_change');
    });

    it('streams diff events directly to callbacks', async () => {
        const callbacks: OpenCodeSessionCallbacks = {
            onDiff: () => {},
        };
        let seenDiff: any[] | undefined;
        callbacks.onDiff = (...args: any[]) => {
            seenDiff = args;
        };
        session = new OpenCodeSession(transport, callbacks);

        const runPromise = session.run(baseOptions());
        transport.emitEvent({
            type: 'diff',
            path: testFilePath,
            oldText: 'return 0',
            newText: 'return 9',
            toolCallId: 'tc_diff_1',
        });
        transport.emitEvent({ type: 'done' });
        await runPromise;

        expect(seenDiff?.[0]).to.equal(testFilePath);
        expect(seenDiff?.[3]).to.equal('tc_diff_1');
    });

    it('returns a cancellation result when cancel() is called', async () => {
        const runPromise = session.run(baseOptions());
        setTimeout(() => session.cancel(), 10);
        const result = await runPromise;

        expect(result.success).to.equal(false);
        expect(result.outcome).to.equal('failed');
        expect(result.finalMessage).to.equal('Fix cancelled by user');
        expect(transport.cancelled).to.equal(true);
    });

    it('propagates transport errors', async () => {
        const runPromise = session.run(baseOptions());
        transport.emitError(new Error('aborted'));

        try {
            await runPromise;
            throw new Error('expected rejection');
        } catch (error) {
            expect((error as Error).message).to.include('Transport error');
        }
    });

    it('deduplicates repeated OpenCode error messages', async () => {
        const callbacks: OpenCodeSessionCallbacks = {};
        const streamed: string[] = [];
        callbacks.onMessageChunk = (chunk) => {
            if (chunk.type === 'text_delta' && chunk.delta) {
                streamed.push(chunk.delta);
            }
        };
        session = new OpenCodeSession(transport, callbacks);

        const quotaMessage = 'You have reached your usage limit for this billing cycle.';
        const runPromise = session.run(baseOptions());
        transport.emitEvent({ type: 'session.error', error: quotaMessage });
        transport.emitEvent({ type: 'message.updated', properties: { info: { role: 'assistant', time: { completed: 1 }, error: quotaMessage } } });
        const result = await runPromise;

        expect(result.success).to.equal(false);
        expect(result.finalMessage).to.equal(quotaMessage);
        expect(streamed.filter((delta) => delta.includes(quotaMessage))).to.have.length(1);
    });

    it('maps NO_FIX_NEEDED to a no_change outcome', async () => {
        const runPromise = session.run(baseOptions());
        transport.emitEvent({ type: 'text', part: { text: 'NO_FIX_NEEDED: copyLen is already used on the bounded write path.' } });
        transport.emitEvent({ type: 'done' });
        const result = await runPromise;

        expect(result.success).to.equal(false);
        expect(result.outcome).to.equal('no_change');
        expect(result.finalMessage).to.equal('copyLen is already used on the bounded write path.');
        expect(result.fileChanged).to.equal(false);
    });

    it('maps CANNOT_FIX to a failed outcome with the model reason', async () => {
        const runPromise = session.run(baseOptions());
        transport.emitEvent({ type: 'text', part: { text: 'CANNOT_FIX: missing runtime context for the surrounding tensor contract.' } });
        transport.emitEvent({ type: 'done' });
        const result = await runPromise;

        expect(result.success).to.equal(false);
        expect(result.outcome).to.equal('failed');
        expect(result.finalMessage).to.equal('missing runtime context for the surrounding tensor contract.');
        expect(result.fileChanged).to.equal(false);
    });

    it('reports an unexplained no-op when no edits and no terminal marker are produced', async () => {
        const runPromise = session.run(baseOptions());
        transport.emitEvent({ type: 'text', part: { text: 'I reviewed the file and stopped.' } });
        transport.emitEvent({ type: 'done' });
        const result = await runPromise;

        expect(result.success).to.equal(false);
        expect(result.outcome).to.equal('failed');
        expect(result.finalMessage).to.include('did not provide a parseable reason');
        expect(result.fileChanged).to.equal(false);
    });
});

describe('detectPlaceholderResponse', () => {
    it('detects explicit placeholder phrases', () => {
        const reason = detectPlaceholderResponse('/* rest of file unchanged */', 'int x = 0;');
        expect(reason).to.include('placeholder phrase');
    });

    it('allows diff-like responses', () => {
        const reason = detectPlaceholderResponse('@@\n- old\n+ new\n', 'old');
        expect(reason).to.equal('');
    });

    it('detects focused snippet line markers', () => {
        const snippet = '>   30 |         DataCopy(zLocal, xLocal, 2* TILE_LENGTH);\n    31 | \n';
        const reason = detectPlaceholderResponse(snippet, 'int main() { return 0; }');
        expect(reason).to.include('focused snippet');
    });

    it('allows normal code even with numbers in it', () => {
        const code = 'int x = 25;\nfloat y = 30.5;\n';
        const reason = detectPlaceholderResponse(code, 'int main() { return 0; }');
        expect(reason).to.equal('');
    });
});
