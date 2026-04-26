import { expect } from 'chai';
import * as sinon from 'sinon';
import * as child_process from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import {
    createTransport,
    _setTestDeps,
    _resetTestDeps,
} from './opencodeTransport';

class MockWritable extends EventEmitter {
    public written: Buffer[] = [];

    write(chunk: string | Buffer): boolean {
        this.written.push(Buffer.from(chunk));
        return true;
    }
}

class MockChildProcess extends EventEmitter {
    public stdin = new MockWritable();
    public stdout = new EventEmitter();
    public stderr = new EventEmitter();
    public killed = false;

    kill(_signal?: NodeJS.Signals | number): boolean {
        this.killed = true;
        return true;
    }
}

class MockClientRequest extends EventEmitter {
    public destroyed = false;
    public callback?: (res: http.IncomingMessage) => void;
    public written: Buffer[] = [];

    end(): void {}

    write(chunk: string): boolean {
        this.written.push(Buffer.from(chunk));
        return true;
    }

    destroy(_error?: Error): this {
        this.destroyed = true;
        return this;
    }
}

class MockIncomingMessage extends EventEmitter {
    public statusCode = 200;
    public headers: http.IncomingHttpHeaders = {};

    setEncoding(_encoding: string): this {
        return this;
    }
}

describe('opencodeTransport', () => {
    let clock: sinon.SinonFakeTimers;
    let spawnStub: sinon.SinonStub;
    let httpRequestStub: sinon.SinonStub;

    beforeEach(() => {
        clock = sinon.useFakeTimers();
        spawnStub = sinon.stub().returns(new MockChildProcess() as unknown as child_process.ChildProcess);
        httpRequestStub = sinon.stub().callsFake((options: any, callback?: any) => {
            const req = new MockClientRequest();
            req.callback = typeof callback === 'function' ? callback : undefined;
            return req as unknown as http.ClientRequest;
        });

        _setTestDeps({
            spawn: spawnStub as any,
            httpRequest: httpRequestStub as any,
        });
        (vscode.workspace as any).textDocuments = [];
    });

    afterEach(() => {
        sinon.restore();
        clock.restore();
        _resetTestDeps();
    });

    function getRequestByPath(pathname: string): MockClientRequest {
        const call = httpRequestStub.getCalls().find((entry) => entry.args[0]?.path === pathname);
        expect(call, `expected request for ${pathname}`).to.not.equal(undefined);
        return call!.returnValue as unknown as MockClientRequest;
    }

    function serverConfig(overrides: Record<string, unknown> = {}) {
        return {
            mode: 'server' as const,
            servePort: 7325,
            timeoutMs: 1000,
            providerID: 'volcengine-plan',
            model: 'doubao-seed-2.0-code',
            modelFullName: 'volcengine-plan/doubao-seed-2.0-code',
            ...overrides,
        };
    }

    function bodyOf(req: MockClientRequest): any {
        return JSON.parse(Buffer.concat(req.written).toString('utf-8'));
    }

    function respondWithJson(req: MockClientRequest, body: unknown, statusCode = 200): void {
        const res = new MockIncomingMessage();
        res.statusCode = statusCode;
        req.callback?.(res as unknown as http.IncomingMessage);
        if (statusCode !== 204) {
            res.emit('data', Buffer.from(JSON.stringify(body)));
        }
        res.emit('end');
    }

    function openSse(req: MockClientRequest): MockIncomingMessage {
        const res = new MockIncomingMessage();
        res.statusCode = 200;
        req.callback?.(res as unknown as http.IncomingMessage);
        return res;
    }

    it('creates server and acp transports', () => {
        expect(createTransport({ mode: 'server', timeoutMs: 1000 })).to.have.property('start');
        expect(createTransport({ mode: 'acp', timeoutMs: 1000 })).to.have.property('start');
        expect(() => createTransport({ mode: 'oops' as any, timeoutMs: 1000 })).to.throw('Unknown transport mode');
    });

    it('server cancel waits for the abort grace period before closing the SSE connection', () => {
        const transport = createTransport({ mode: 'server', timeoutMs: 1000 });
        const closeSpy = sinon.spy();
        transport.onClose(closeSpy);

        const req = new MockClientRequest();
        (transport as any).sessionId = 'sess_1';
        (transport as any).sseReq = req;
        transport.cancel();

        expect(req.destroyed).to.equal(false);
        expect(closeSpy.called).to.equal(false);

        clock.tick(499);
        expect(req.destroyed).to.equal(false);
        clock.tick(1);
        expect(req.destroyed).to.equal(true);
        expect(closeSpy.calledOnce).to.equal(true);
    });

    it('server dispose aborts the active OpenCode session and closes SSE immediately', () => {
        const transport = createTransport({ mode: 'server', servePort: 7325, timeoutMs: 1000 });
        const req = new MockClientRequest();
        (transport as any).sessionId = 'sess_dispose';
        (transport as any).sseReq = req;

        transport.dispose();

        expect(req.destroyed).to.equal(true);
        expect(getRequestByPath('/session/sess_dispose/abort')).to.not.equal(undefined);
    });

    it('server subscribes to /event before creating the session', async () => {
        const transport = createTransport(serverConfig());
        transport.start('fix this');

        expect(httpRequestStub.callCount).to.equal(1);
        expect(httpRequestStub.firstCall.args[0].path).to.equal('/global/health');
        respondWithJson(httpRequestStub.firstCall.returnValue as unknown as MockClientRequest, {});
        await Promise.resolve();
        await Promise.resolve();

        expect(httpRequestStub.callCount).to.equal(2);
        expect(httpRequestStub.secondCall.args[0].path).to.equal('/event');

        openSse(httpRequestStub.secondCall.returnValue as unknown as MockClientRequest);
        await Promise.resolve();
        await Promise.resolve();

        expect(httpRequestStub.callCount).to.be.greaterThan(2);
        expect(httpRequestStub.getCall(2).args[0].path).to.equal('/session');
    });

    it('server ignores foreign-session completion events on the global SSE bus', async () => {
        const transport = createTransport(serverConfig());
        const events: unknown[] = [];
        const closeSpy = sinon.spy();
        transport.onEvent((event) => events.push(event));
        transport.onClose(closeSpy);
        transport.start('fix this');

        respondWithJson(httpRequestStub.firstCall.returnValue as unknown as MockClientRequest, {});
        await Promise.resolve();
        await Promise.resolve();

        const sseReq = getRequestByPath('/event');
        const sseRes = openSse(sseReq);
        await Promise.resolve();
        await Promise.resolve();

        respondWithJson(getRequestByPath('/session'), { id: 'sess_current' });
        await Promise.resolve();
        await Promise.resolve();

        respondWithJson(getRequestByPath('/session/sess_current/prompt_async'), {}, 204);
        await Promise.resolve();
        await Promise.resolve();

        sseRes.emit('data', Buffer.from(
            'data: {"type":"message.updated","properties":{"sessionID":"sess_foreign","info":{"id":"msg_foreign","role":"assistant","time":{"created":1,"completed":2}}}}\n\n',
        ));
        clock.tick(300);
        expect(closeSpy.called).to.equal(false);
        expect(events.some((event: any) => event?.properties?.sessionID === 'sess_foreign')).to.equal(false);

        sseRes.emit('data', Buffer.from(
            'data: {"type":"message.updated","properties":{"sessionID":"sess_current","info":{"id":"msg_current","role":"assistant","time":{"created":3,"completed":4}}}}\n\n',
        ));
        clock.tick(250);
        expect(closeSpy.calledOnce).to.equal(true);
        expect(events.some((event: any) => event?.properties?.sessionID === 'sess_current')).to.equal(true);
    });

    it('server sends the configured provider/model to prompt_async and logs the session id', async () => {
        const logs: string[] = [];
        const transport = createTransport(serverConfig(), (message) => logs.push(message));
        transport.start('fix this');

        respondWithJson(httpRequestStub.firstCall.returnValue as unknown as MockClientRequest, {});
        await Promise.resolve();
        await Promise.resolve();

        openSse(getRequestByPath('/event'));
        await Promise.resolve();
        await Promise.resolve();

        respondWithJson(getRequestByPath('/session'), { id: 'sess_model' });
        await Promise.resolve();
        await Promise.resolve();

        expect(logs).to.include('OpenCode session id: sess_model');
        const promptReq = getRequestByPath('/session/sess_model/prompt_async');
        expect(bodyOf(promptReq)).to.deep.equal({
            model: {
                providerID: 'volcengine-plan',
                modelID: 'doubao-seed-2.0-code',
            },
            parts: [{ type: 'text', text: 'fix this' }],
        });
    });

    it('server sends the configured provider/model to message fallback', async () => {
        const transport = createTransport(serverConfig());
        transport.start('fix this');

        respondWithJson(httpRequestStub.firstCall.returnValue as unknown as MockClientRequest, {});
        await Promise.resolve();
        await Promise.resolve();

        openSse(getRequestByPath('/event'));
        await Promise.resolve();
        await Promise.resolve();

        respondWithJson(getRequestByPath('/session'), { id: 'sess_fallback' });
        await Promise.resolve();
        await Promise.resolve();

        respondWithJson(getRequestByPath('/session/sess_fallback/prompt_async'), { error: 'missing' }, 404);
        await Promise.resolve();
        await Promise.resolve();

        const messageReq = getRequestByPath('/session/sess_fallback/message');
        expect(bodyOf(messageReq)).to.deep.equal({
            model: {
                providerID: 'volcengine-plan',
                modelID: 'doubao-seed-2.0-code',
            },
            parts: [{ type: 'text', text: 'fix this' }],
        });
    });

    it('server fails clearly instead of using the OpenCode default model when provider prefix is missing', async () => {
        const transport = createTransport({
            mode: 'server',
            servePort: 7325,
            timeoutMs: 1000,
            model: 'qwen3:8b',
            modelFullName: 'qwen3:8b',
        });
        const errors: string[] = [];
        const closeSpy = sinon.spy();
        transport.onError((error) => errors.push(error.message));
        transport.onClose(closeSpy);

        transport.start('fix this');
        await Promise.resolve();

        expect(errors[0]).to.include('provider/model');
        expect(errors[0]).to.include('Refusing to use the OpenCode server default model');
        expect(closeSpy.calledOnceWith(1)).to.equal(true);
        expect(httpRequestStub.called).to.equal(false);
    });

    it('acp normalizes session/update chunks, logs the session id, and completes on prompt response', async () => {
        const logs: string[] = [];
        const transport = createTransport({
            mode: 'acp',
            cliPath: '/usr/bin/opencode',
            acpArgs: ['acp'],
            timeoutMs: 1000,
            workspaceRoot: '/workspace',
        }, (message) => logs.push(message));
        const events: unknown[] = [];
        const closeSpy = sinon.spy();
        transport.onEvent((event) => events.push(event));
        transport.onClose(closeSpy);

        transport.start('fix this');

        const child = spawnStub.firstCall.returnValue as MockChildProcess;
        const initializeRequest = JSON.parse(child.stdin.written[0].toString());
        child.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: initializeRequest.id,
            result: { protocolVersion: 1, agentCapabilities: {} },
        }) + '\n'));
        await Promise.resolve();
        await Promise.resolve();

        const sessionNewRequest = JSON.parse(child.stdin.written[1].toString());
        child.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: sessionNewRequest.id,
            result: { sessionId: 'sess_abc' },
        }) + '\n'));
        await Promise.resolve();
        await Promise.resolve();

        expect(logs).to.include('OpenCode session id: sess_abc');
        const promptRequest = JSON.parse(child.stdin.written[2].toString());
        child.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
                sessionId: 'sess_abc',
                update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'hello from ACP' },
                },
            },
        }) + '\n'));
        child.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: promptRequest.id,
            result: { stopReason: 'end_turn' },
        }) + '\n'));

        await Promise.resolve();
        await Promise.resolve();
        clock.tick(250);

        expect(events).to.deep.include({ type: 'session_start', sessionId: 'sess_abc' });
        expect(events).to.deep.include({ type: 'text', part: { text: 'hello from ACP' }, messageId: undefined });
        expect(events).to.deep.include({ type: 'done', stopReason: 'end_turn' });
        expect(closeSpy.calledOnce).to.equal(true);
    });

    it('acp sets the configured full model ID when the agent advertises it', async () => {
        const transport = createTransport({
            mode: 'acp',
            cliPath: '/usr/bin/opencode',
            acpArgs: ['acp'],
            timeoutMs: 1000,
            workspaceRoot: '/workspace',
            providerID: 'volcengine-plan',
            model: 'doubao-seed-2.0-code',
            modelFullName: 'volcengine-plan/doubao-seed-2.0-code',
        });
        transport.start('fix this');

        const child = spawnStub.firstCall.returnValue as MockChildProcess;
        const initializeRequest = JSON.parse(child.stdin.written[0].toString());
        child.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: initializeRequest.id,
            result: { protocolVersion: 1, agentCapabilities: {} },
        }) + '\n'));
        await Promise.resolve();
        await Promise.resolve();

        const sessionNewRequest = JSON.parse(child.stdin.written[1].toString());
        child.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: sessionNewRequest.id,
            result: {
                sessionId: 'sess_abc',
                configOptions: [{
                    id: 'model',
                    currentValue: 'moonshot/kimi-k2.6',
                    options: [
                        { value: 'moonshot/kimi-k2.6' },
                        { value: 'volcengine-plan/doubao-seed-2.0-code' },
                    ],
                }],
            },
        }) + '\n'));
        await Promise.resolve();
        await Promise.resolve();

        const setModelRequest = JSON.parse(child.stdin.written[2].toString());
        expect(setModelRequest.method).to.equal('session/set_config_option');
        expect(setModelRequest.params.value).to.equal('volcengine-plan/doubao-seed-2.0-code');
    });

    it('acp responds to fs/read_text_file requests using the local filesystem', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msagent-acp-'));
        const filePath = path.join(tempDir, 'test.cpp');
        fs.writeFileSync(filePath, 'alpha\nbeta\ngamma\n', 'utf-8');

        try {
            const transport = createTransport({
                mode: 'acp',
                cliPath: '/usr/bin/opencode',
                acpArgs: ['acp'],
                timeoutMs: 1000,
                workspaceRoot: tempDir,
            });

            transport.start('fix this');
            const child = spawnStub.firstCall.returnValue as MockChildProcess;

            const initializeRequest = JSON.parse(child.stdin.written[0].toString());
            child.stdout.emit('data', Buffer.from(JSON.stringify({
                jsonrpc: '2.0',
                id: initializeRequest.id,
                result: { protocolVersion: 1, agentCapabilities: {} },
            }) + '\n'));
            await Promise.resolve();
            await Promise.resolve();

            const sessionNewRequest = JSON.parse(child.stdin.written[1].toString());
            child.stdout.emit('data', Buffer.from(JSON.stringify({
                jsonrpc: '2.0',
                id: sessionNewRequest.id,
                result: { sessionId: 'sess_abc' },
            }) + '\n'));
            await Promise.resolve();
            await Promise.resolve();

            child.stdout.emit('data', Buffer.from(JSON.stringify({
                jsonrpc: '2.0',
                id: 99,
                method: 'fs/read_text_file',
                params: {
                    sessionId: 'sess_abc',
                    path: filePath,
                    line: 2,
                    limit: 1,
                },
            }) + '\n'));

            await Promise.resolve();
            await Promise.resolve();

            const response = child.stdin.written
                .map((buffer) => JSON.parse(buffer.toString()))
                .find((message) => message.id === 99);
            expect(response.result.content).to.equal('beta');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
