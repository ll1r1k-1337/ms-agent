import { expect } from 'chai';
import * as sinon from 'sinon';
import * as child_process from 'child_process';
import * as http from 'http';
import { EventEmitter } from 'events';
import {
    createTransport,
    _setTestDeps,
    _resetTestDeps,
} from './opencodeTransport';
import {
    _installFakeRawEventChannelForTests,
    _resetRawEventChannelForTests,
} from '../vscode/rawEventChannel';

class MockChildProcess extends EventEmitter {
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

    end(): void {}

    destroy(_error?: Error): this {
        this.destroyed = true;
        return this;
    }
}

class MockIncomingMessage extends EventEmitter {
    public statusCode = 200;

    resume(): void {}
}

class ManualAsyncStream<T> implements AsyncIterable<T> {
    private readonly queue: T[] = [];
    private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
    private done = false;

    push(value: T): void {
        if (this.done) {
            return;
        }
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter({ value, done: false });
            return;
        }
        this.queue.push(value);
    }

    end(): void {
        this.done = true;
        while (this.waiters.length > 0) {
            this.waiters.shift()?.({ value: undefined as T, done: true });
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: () => {
                if (this.queue.length > 0) {
                    return Promise.resolve({ value: this.queue.shift() as T, done: false });
                }
                if (this.done) {
                    return Promise.resolve({ value: undefined as T, done: true });
                }
                return new Promise((resolve) => {
                    this.waiters.push(resolve);
                });
            },
        };
    }
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) {
            return;
        }
        await flushMicrotasks();
    }
    expect.fail(message);
}

describe('opencodeTransport', () => {
    let clock: sinon.SinonFakeTimers;
    let spawnStub: sinon.SinonStub;
    let httpRequestStub: sinon.SinonStub;
    let sdkCalls: string[];
    let stream: ManualAsyncStream<unknown>;
    let abortSpy: sinon.SinonSpy;
    let promptAsyncStub: sinon.SinonStub;
    let createSessionStub: sinon.SinonStub;
    let readMessagesStub: sinon.SinonStub;
    let abortSessionStub: sinon.SinonStub;
    let permissionRespondStub: sinon.SinonStub;
    let rawEventLines: string[];

    beforeEach(() => {
        clock = sinon.useFakeTimers();
        // Route raw-event logging to a fake so the runner does not spam the
        // console fallback for every event these tests push through it.
        rawEventLines = _installFakeRawEventChannelForTests().lines;
        sdkCalls = [];
        stream = new ManualAsyncStream<unknown>();
        abortSpy = sinon.spy();
        promptAsyncStub = sinon.stub().callsFake(async () => {
            sdkCalls.push('promptAsync');
        });
        createSessionStub = sinon.stub().callsFake(async () => {
            sdkCalls.push('createSession');
            return { data: { id: 'sess_current' } };
        });
        readMessagesStub = sinon.stub().resolves({
            data: [
                { id: 'msg_final', role: 'assistant', parts: [{ type: 'text', text: 'Changed the bound.' }] },
            ],
        });
        abortSessionStub = sinon.stub().callsFake(async () => {
            sdkCalls.push('abortSession');
        });
        permissionRespondStub = sinon.stub().resolves(true);

        spawnStub = sinon.stub().returns(new MockChildProcess() as unknown as child_process.ChildProcess);
        httpRequestStub = sinon.stub().callsFake((_options: any, callback?: any) => {
            const req = new MockClientRequest();
            req.callback = typeof callback === 'function' ? callback : undefined;
            const res = new MockIncomingMessage();
            req.callback?.(res as unknown as http.IncomingMessage);
            return req as unknown as http.ClientRequest;
        });

        _setTestDeps({
            spawn: spawnStub as any,
            httpRequest: httpRequestStub as any,
            createSdkClient: () => ({
                event: {
                    subscribe: async () => {
                        sdkCalls.push('subscribeEvents');
                        return {
                            stream,
                            controller: {
                                abort: abortSpy,
                            },
                        };
                    },
                },
                session: {
                    create: createSessionStub,
                    promptAsync: promptAsyncStub,
                    abort: abortSessionStub.callsFake(async () => undefined),
                    messages: readMessagesStub,
                },
                permission: {
                    respond: permissionRespondStub,
                },
            }),
        });
    });

    afterEach(() => {
        sinon.restore();
        clock.restore();
        _resetTestDeps();
        _resetRawEventChannelForTests();
    });

    function serverConfig(overrides: Record<string, unknown> = {}) {
        return {
            servePort: 7325,
            timeoutMs: 1000,
            providerID: 'volcengine-plan',
            model: 'doubao-seed-2.0-code',
            modelFullName: 'volcengine-plan/doubao-seed-2.0-code',
            ...overrides,
        };
    }

    it('creates the SDK-backed server transport', () => {
        expect(createTransport({ timeoutMs: 1000 })).to.have.property('start');
    });

    it('subscribes before creating the session and sending the prompt', async () => {
        const transport = createTransport(serverConfig());
        transport.start('fix this');
        await waitFor(() => sdkCalls.includes('promptAsync'), 'expected promptAsync to be called');

        expect(sdkCalls).to.deep.equal(['subscribeEvents', 'createSession', 'promptAsync']);
    });

    it('can read the current session message list after the session is created', async () => {
        const transport = createTransport(serverConfig());
        transport.start('fix this');
        await waitFor(() => sdkCalls.includes('createSession'), 'expected session creation to complete');

        const messages = await transport.readSessionMessages();
        expect(messages).to.deep.equal([
            { id: 'msg_final', role: 'assistant', parts: [{ type: 'text', text: 'Changed the bound.' }] },
        ]);
        expect(readMessagesStub.calledOnceWithExactly({ sessionID: 'sess_current' })).to.equal(true);
    });

    it('ignores foreign-session completion events on the global SDK event stream', async () => {
        const transport = createTransport(serverConfig());
        const events: unknown[] = [];
        const closeSpy = sinon.spy();
        transport.onEvent((event) => events.push(event));
        transport.onClose(closeSpy);
        transport.start('fix this');
        await waitFor(() => sdkCalls.includes('promptAsync'), 'expected promptAsync to be called');

        stream.push({
            type: 'message.updated',
            properties: {
                sessionID: 'sess_foreign',
                info: { id: 'msg_foreign', role: 'assistant', time: { created: 1, completed: 2 } },
            },
        });
        await Promise.resolve();
        clock.tick(300);
        expect(closeSpy.called).to.equal(false);
        expect(events.some((event: any) => event?.properties?.sessionID === 'sess_foreign')).to.equal(false);

        stream.push({
            type: 'message.updated',
            properties: {
                sessionID: 'sess_current',
                info: { id: 'msg_current', role: 'assistant', time: { created: 3, completed: 4 } },
            },
        });
        await Promise.resolve();
        clock.tick(250);
        expect(closeSpy.calledOnceWith(0)).to.equal(true);
        expect(events.some((event: any) => event?.properties?.sessionID === 'sess_current')).to.equal(true);
    });

    it('mirrors every SDK event to the raw-events channel before session filtering', async () => {
        const transport = createTransport(serverConfig());
        transport.onEvent(() => {});
        transport.start('fix this');
        await waitFor(() => sdkCalls.includes('promptAsync'), 'expected promptAsync to be called');

        // Belongs to this runner's session — forwarded downstream (emit).
        stream.push({
            type: 'message.part.updated',
            properties: {
                sessionID: 'sess_current',
                part: { type: 'tool', tool: 'grep', callID: 'tc_1', state: { status: 'running' } },
            },
        });
        // Belongs to a different session sharing the same OpenCode server —
        // dropped by the runner's filter, but still recorded verbatim (skip).
        stream.push({
            type: 'message.part.updated',
            properties: {
                sessionID: 'sess_foreign',
                part: { type: 'tool', tool: 'grep', callID: 'tc_2', state: { status: 'running' } },
            },
        });
        await flushMicrotasks();

        const emitLine = rawEventLines.find(
            (line) => line.includes(' emit ') && line.includes('"sessionID":"sess_current"'),
        );
        const skipLine = rawEventLines.find(
            (line) => line.includes(' skip ') && line.includes('"sessionID":"sess_foreign"'),
        );
        expect(emitLine, 'expected an emit line for the owned session').to.not.equal(undefined);
        expect(skipLine, 'expected a skip line for the foreign session').to.not.equal(undefined);
        expect(emitLine).to.contain('[sess_current]');
        expect(emitLine).to.contain('message.part.updated');
        expect(emitLine).to.contain('"tool":"grep"');
    });

    it('keeps the SDK event stream open after a read-only tool-calls boundary', async () => {
        const logs: string[] = [];
        const transport = createTransport(serverConfig({ timeoutMs: 5000 }), (message) => logs.push(message));
        const events: unknown[] = [];
        const closeSpy = sinon.spy();
        transport.onEvent((event) => events.push(event));
        transport.onClose(closeSpy);
        transport.start('fix this');
        await waitFor(() => sdkCalls.includes('promptAsync'), 'expected promptAsync to be called');

        stream.push({
            type: 'message.updated',
            properties: {
                sessionID: 'sess_current',
                info: { id: 'msg_read', role: 'assistant', sessionID: 'sess_current', time: { created: 1 } },
            },
        });
        stream.push({
            type: 'message.part.updated',
            properties: {
                sessionID: 'sess_current',
                part: {
                    type: 'tool',
                    tool: 'read',
                    callID: 'tool_read_1',
                    messageID: 'msg_read',
                    sessionID: 'sess_current',
                    state: { status: 'pending', input: {} },
                },
            },
        });
        stream.push({
            type: 'message.part.updated',
            properties: {
                sessionID: 'sess_current',
                part: {
                    type: 'tool',
                    tool: 'read',
                    callID: 'tool_read_1',
                    messageID: 'msg_read',
                    sessionID: 'sess_current',
                    state: { status: 'completed', output: 'file content' },
                },
            },
        });
        stream.push({
            type: 'message.updated',
            properties: {
                sessionID: 'sess_current',
                info: {
                    id: 'msg_read',
                    role: 'assistant',
                    sessionID: 'sess_current',
                    finish: 'tool-calls',
                    time: { created: 1, completed: 2 },
                },
            },
        });
        await flushMicrotasks();
        clock.tick(1000);

        expect(closeSpy.called).to.equal(false);
        expect(abortSpy.called).to.equal(false);
        expect(events.some((event: any) => event?.properties?.info?.id === 'msg_read')).to.equal(true);
        expect(logs.some((line) => line.includes('keeping event stream open after read-only tool boundary'))).to.equal(true);

        stream.push({
            type: 'message.updated',
            properties: {
                sessionID: 'sess_current',
                info: { id: 'msg_edit', role: 'assistant', sessionID: 'sess_current', time: { created: 3 } },
            },
        });
        stream.push({
            type: 'message.part.updated',
            properties: {
                sessionID: 'sess_current',
                part: {
                    type: 'tool',
                    tool: 'edit_file',
                    callID: 'tool_edit_1',
                    messageID: 'msg_edit',
                    sessionID: 'sess_current',
                    state: { status: 'pending', input: { path: 'test.cpp' } },
                },
            },
        });
        stream.push({
            type: 'message.part.updated',
            properties: {
                sessionID: 'sess_current',
                part: {
                    type: 'tool',
                    tool: 'edit_file',
                    callID: 'tool_edit_1',
                    messageID: 'msg_edit',
                    sessionID: 'sess_current',
                    state: { status: 'completed', output: 'ok' },
                },
            },
        });
        stream.push({
            type: 'message.updated',
            properties: {
                sessionID: 'sess_current',
                info: {
                    id: 'msg_edit',
                    role: 'assistant',
                    sessionID: 'sess_current',
                    finish: 'tool-calls',
                    time: { created: 3, completed: 4 },
                },
            },
        });
        await flushMicrotasks();
        clock.tick(250);

        expect(closeSpy.calledOnceWith(0)).to.equal(true);
    });

    it('cancel waits for the abort grace period before closing the event stream', async () => {
        const transport = createTransport(serverConfig());
        const closeSpy = sinon.spy();
        transport.onClose(closeSpy);
        transport.start('fix this');
        await waitFor(() => sdkCalls.includes('createSession'), 'expected session creation to complete');

        transport.cancel();
        await flushMicrotasks();
        expect(abortSpy.called).to.equal(false);
        expect(closeSpy.called).to.equal(false);
        expect(abortSessionStub.calledOnceWithExactly({ sessionID: 'sess_current' })).to.equal(true);

        clock.tick(499);
        expect(abortSpy.called).to.equal(false);
        clock.tick(1);
        expect(abortSpy.calledOnce).to.equal(true);
        expect(closeSpy.calledOnceWith(0)).to.equal(true);
    });

    it('fails clearly instead of using the OpenCode default model when provider prefix is missing', async () => {
        const transport = createTransport({
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
    });

    it('auto-approves a permission.asked external read, including subagent sessions', async () => {
        const transport = createTransport(serverConfig());
        transport.onEvent(() => {});
        transport.start('fix this');
        await waitFor(() => sdkCalls.includes('promptAsync'), 'expected promptAsync to be called');

        // A `task` subagent runs in a child session; its permission ask must
        // still be answered (handled before the session-scope filter).
        stream.push({
            type: 'permission.asked',
            properties: {
                id: 'per_ext_1',
                sessionID: 'sess_subagent',
                permission: 'external_directory',
                patterns: ['/home/developer/Ascend/cann-9.0.0/*'],
                metadata: { filepath: '/home/developer/Ascend/cann-9.0.0/asc/include/kernel_operator.h' },
                always: [],
            },
        });
        await waitFor(() => permissionRespondStub.called, 'expected the permission to be answered');

        expect(permissionRespondStub.calledOnceWithExactly({
            sessionID: 'sess_subagent',
            permissionID: 'per_ext_1',
            response: 'once',
        })).to.equal(true);
    });

    it('rejects a permission.asked that targets a credential file', async () => {
        const transport = createTransport(serverConfig());
        transport.onEvent(() => {});
        transport.start('fix this');
        await waitFor(() => sdkCalls.includes('promptAsync'), 'expected promptAsync to be called');

        stream.push({
            type: 'permission.asked',
            properties: {
                id: 'per_secret_1',
                sessionID: 'sess_current',
                permission: 'external_directory',
                patterns: [],
                metadata: { filepath: '/home/developer/.local/share/opencode/auth.json' },
                always: [],
            },
        });
        await waitFor(() => permissionRespondStub.called, 'expected the permission to be answered');

        expect(permissionRespondStub.calledOnceWithExactly({
            sessionID: 'sess_current',
            permissionID: 'per_secret_1',
            response: 'reject',
        })).to.equal(true);
    });
});
