import { expect } from 'chai';
import * as sinon from 'sinon';
import {
    _resetSdkClientTestFactory,
    _setSdkClientTestFactory,
    OpenCodeSdkClient,
} from './opencodeSdkClient';

describe('OpenCodeSdkClient', () => {
    afterEach(() => {
        sinon.restore();
        _resetSdkClientTestFactory();
    });

    it('subscribes to events and exposes a close handle', async () => {
        const abortSpy = sinon.spy();
        const stream = {
            async *[Symbol.asyncIterator]() {
                yield { type: 'server.heartbeat' };
            },
        };
        _setSdkClientTestFactory(() => ({
            event: {
                subscribe: async () => ({
                    stream,
                    controller: { abort: abortSpy },
                }),
            },
        }));

        const client = new OpenCodeSdkClient({
            baseUrl: 'http://127.0.0.1:7325',
            timeoutMs: 1000,
        });

        const subscription = await client.subscribeEvents();
        const events: unknown[] = [];
        for await (const event of subscription.stream) {
            events.push(event);
        }
        subscription.close();

        expect(events).to.deep.equal([{ type: 'server.heartbeat' }]);
        expect(abortSpy.calledOnce).to.equal(true);
    });

    it('sends promptAsync with the configured model and parts', async () => {
        const promptAsync = sinon.stub().resolves({});
        _setSdkClientTestFactory(() => ({
            session: {
                promptAsync,
            },
        }));

        const client = new OpenCodeSdkClient({
            baseUrl: 'http://127.0.0.1:7325',
            timeoutMs: 1000,
        });

        await client.promptSession('sess_123', {
            model: {
                providerID: 'opencode',
                modelID: 'big-pickle',
            },
            parts: [{ type: 'text', text: 'fix this' }],
        });

        expect(promptAsync.calledOnceWithExactly({
            sessionID: 'sess_123',
            model: {
                providerID: 'opencode',
                modelID: 'big-pickle',
            },
            parts: [{ type: 'text', text: 'fix this' }],
        })).to.equal(true);
    });

    it('normalizes session messages from the SDK data payload', async () => {
        _setSdkClientTestFactory(() => ({
            session: {
                messages: async () => ({
                    data: [
                        { id: 'msg_1', role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
                    ],
                }),
            },
        }));

        const client = new OpenCodeSdkClient({
            baseUrl: 'http://127.0.0.1:7325',
            timeoutMs: 1000,
        });

        const messages = await client.readSessionMessages('sess_123');
        expect(messages).to.deep.equal([
            { id: 'msg_1', role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
        ]);
    });

    it('does not pass Authorization headers through the SDK client config', async () => {
        const capturedConfigs: Record<string, unknown>[] = [];
        _setSdkClientTestFactory((config) => {
            capturedConfigs.push(config);
            return {
                session: {
                    create: async () => ({ data: { id: 'sess_123' } }),
                },
            };
        });

        const client = new OpenCodeSdkClient({
            baseUrl: 'http://127.0.0.1:7325',
            timeoutMs: 1000,
        });

        await client.createSession();

        expect(capturedConfigs).to.have.length(1);
        expect(capturedConfigs[0]).to.deep.equal({
            baseUrl: 'http://127.0.0.1:7325',
            timeout: 1000,
        });
    });
});
