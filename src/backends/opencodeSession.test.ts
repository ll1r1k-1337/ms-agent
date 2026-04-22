import { expect } from 'chai';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as toolHandlers from '../tools/toolHandlers';
import { OpenCodeSession, OpenCodeSessionCallbacks } from './opencodeSession';
import { OpenCodeTransport } from './opencodeTransport';

class MockTransport implements OpenCodeTransport {
    private eventCallback?: (event: unknown) => void;
    private errorCallback?: (error: Error) => void;
    private closeCallback?: (exitCode: number | null) => void;
    public sent: unknown[] = [];
    public cancelled = false;

    onEvent(cb: (event: unknown) => void): void {
        this.eventCallback = cb;
    }

    onError(cb: (error: Error) => void): void {
        this.errorCallback = cb;
    }

    onClose(cb: (exitCode: number | null) => void): void {
        this.closeCallback = cb;
    }

    start(_prompt: string): void {
    }

    send(data: unknown): void {
        this.sent.push(data);
    }

    cancel(): void {
        this.cancelled = true;
    }

    dispose(): void {
    }

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
    let executeToolStub: sinon.SinonStub;
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
        executeToolStub = sinon.stub(toolHandlers, 'executeTool').resolves('Success');
    });

    afterEach(() => {
        sinon.restore();
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should complete successfully with code block', async () => {
        const callbacks: OpenCodeSessionCallbacks = {
            onMessageChunk: sinon.stub(),
            onDiff: sinon.stub(),
        };
        session = new OpenCodeSession(transport, callbacks);

        const runPromise = session.run(baseOptions());
        transport.emitEvent({ type: 'text', part: { text: '```cpp\nint main() { return 1; }\n```' } });
        transport.emitEvent({ type: 'done' });
        const result = await runPromise;

        expect(result.success).to.be.true;
        expect(result.fileChanged).to.be.true;
        expect(result.toolCallCount).to.equal(0);
        expect(result.originalContent).to.equal(baseOptions().originalContent);
        expect(result.newContent).to.equal('int main() { return 1; }');
        expect((callbacks.onDiff as sinon.SinonStub).calledOnce).to.be.true;
    });

    it('should return success=false when code is identical', async () => {
        const runPromise = session.run(baseOptions());
        transport.emitEvent({ type: 'text', part: { text: '```cpp\nint main() { return 0; }\n```' } });
        transport.emitEvent({ type: 'done' });
        const result = await runPromise;

        expect(result.success).to.be.false;
        expect(result.fileChanged).to.be.false;
        expect(result.newContent).to.be.undefined;
    });

    it('should handle tool_call event and send result back', async () => {
        const callbacks: OpenCodeSessionCallbacks = {
            onToolCall: sinon.stub(),
            onToolResult: sinon.stub(),
        };
        session = new OpenCodeSession(transport, callbacks);
        executeToolStub.resolves('File content here');

        const runPromise = session.run(baseOptions());
        transport.emitEvent({
            type: 'tool_call',
            tool_call: { name: 'read_file', arguments: '{"path":"test.cpp"}', id: 'tc1' },
        });
        await new Promise((r) => setImmediate(r));
        transport.emitEvent({ type: 'text', part: { text: '```cpp\nint main() { return 2; }\n```' } });
        transport.emitEvent({ type: 'done' });
        const result = await runPromise;

        expect(result.success).to.be.true;
        expect(executeToolStub.calledOnce).to.be.true;
        expect(executeToolStub.firstCall.args[0]).to.equal('read_file');
        expect(executeToolStub.firstCall.args[1]).to.deep.equal({ path: 'test.cpp' });
        expect(executeToolStub.firstCall.args[2]).to.deep.equal({ workspaceRoot: tempDir });

        expect(transport.sent.length).to.be.at.least(1);
        const sent = transport.sent[0] as { type: string; tool_result: { toolCallId: string; result: string; isError: boolean } };
        expect(sent.type).to.equal('tool_result');
        expect(sent.tool_result.result).to.equal('File content here');
        expect(sent.tool_result.isError).to.be.false;

        const onToolCall = callbacks.onToolCall as sinon.SinonStub;
        const onToolResult = callbacks.onToolResult as sinon.SinonStub;
        expect(onToolCall.calledOnce).to.be.true;
        expect(onToolResult.calledOnce).to.be.true;
    });

    it('should handle error event and return success=false', async () => {
        const runPromise = session.run(baseOptions());
        transport.emitEvent({ type: 'error', error: { message: 'Model overloaded' } });
        transport.emitEvent({ type: 'done' });
        const result = await runPromise;

        expect(result.success).to.be.false;
        expect(result.finalMessage).to.include('Model overloaded');
        expect(result.fileChanged).to.be.false;
    });

    it('should handle cancel() and return cancellation result', async () => {
        const runPromise = session.run(baseOptions());
        setTimeout(() => session.cancel(), 10);
        const result = await runPromise;

        expect(result.success).to.be.false;
        expect(result.finalMessage).to.equal('Fix cancelled by user');
        expect(transport.cancelled).to.be.true;
        expect(result.fileChanged).to.be.false;
    });

    it('should return success=false when no code block is found', async () => {
        const runPromise = session.run(baseOptions());
        transport.emitEvent({ type: 'text', part: { text: 'Sorry, I cannot fix this.' } });
        transport.emitEvent({ type: 'done' });
        const result = await runPromise;

        expect(result.success).to.be.false;
        expect(result.fileChanged).to.be.false;
    });

    it('should count multiple tool calls correctly', async () => {
        executeToolStub.resolves('ok');

        const runPromise = session.run(baseOptions());
        transport.emitEvent({
            type: 'tool_call',
            tool_call: { name: 'read_file', arguments: '{}', id: 'tc1' },
        });
        transport.emitEvent({
            type: 'tool_call',
            tool_call: { name: 'edit_file', arguments: '{}', id: 'tc2' },
        });
        await new Promise((r) => setImmediate(r));
        transport.emitEvent({ type: 'text', part: { text: '```cpp\nint main() { return 42; }\n```' } });
        transport.emitEvent({ type: 'done' });
        const result = await runPromise;

        expect(result.success).to.be.true;
        expect(result.toolCallCount).to.equal(2);
        expect(executeToolStub.callCount).to.equal(2);
    });
});
