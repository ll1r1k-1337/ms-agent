import { expect } from 'chai';
import {
    getRawEventChannel,
    logRawEvent,
    rawEventType,
    stringifyRawEvent,
    _installFakeRawEventChannelForTests,
    _resetRawEventChannelForTests,
} from './rawEventChannel';

describe('rawEventChannel', () => {
    afterEach(() => {
        _resetRawEventChannelForTests();
    });

    describe('rawEventType', () => {
        it('returns the top-level type discriminator for a wire envelope', () => {
            expect(rawEventType({ type: 'message.part.updated', properties: {} }))
                .to.equal('message.part.updated');
            expect(rawEventType({ type: 'server.heartbeat', properties: {} }))
                .to.equal('server.heartbeat');
        });

        it('returns (no-type) for objects without a usable type', () => {
            expect(rawEventType({})).to.equal('(no-type)');
            expect(rawEventType({ type: '' })).to.equal('(no-type)');
            expect(rawEventType({ type: 42 })).to.equal('(no-type)');
        });

        it('returns parenthesized markers for non-object inputs', () => {
            expect(rawEventType(null)).to.equal('(null)');
            expect(rawEventType(undefined)).to.equal('(undefined)');
            expect(rawEventType('hello')).to.equal('(string)');
            expect(rawEventType(7)).to.equal('(number)');
        });
    });

    describe('stringifyRawEvent', () => {
        it('serializes a small event to compact single-line JSON', () => {
            const json = stringifyRawEvent({ type: 'session.idle', properties: { a: 1 } });
            expect(json).to.equal('{"type":"session.idle","properties":{"a":1}}');
        });

        it('truncates payloads longer than the cap and reports how much was dropped', () => {
            const big = { type: 'tool', output: 'x'.repeat(500) };
            const result = stringifyRawEvent(big, 80);
            expect(result.length).to.be.greaterThan(80);
            expect(result.slice(0, 80)).to.equal(JSON.stringify(big).slice(0, 80));
            expect(result).to.contain('… [truncated ');
            expect(result).to.contain(' chars]');
        });

        it('returns a placeholder for unserializable (circular) events without throwing', () => {
            const cyclic: Record<string, unknown> = { type: 'tool' };
            cyclic.self = cyclic;
            expect(stringifyRawEvent(cyclic)).to.equal('[unserializable event]');
        });

        it('handles undefined without throwing', () => {
            expect(stringifyRawEvent(undefined)).to.equal('undefined');
        });
    });

    describe('getRawEventChannel', () => {
        it('falls back to a no-op console-backed channel when nothing is installed', () => {
            const channel = getRawEventChannel();
            expect(() => channel.appendLine('hello')).to.not.throw();
            expect(() => channel.show(true)).to.not.throw();
            expect(() => channel.dispose()).to.not.throw();
        });

        it('recovers a channel published on the global by another module instance', () => {
            _resetRawEventChannelForTests();
            const lines: string[] = [];
            // Key must match GLOBAL_KEY in rawEventChannel.ts — the channel is
            // stashed on `global` so a separately-loaded module copy (e.g. the
            // turn runner) can find it without the extension context.
            (global as unknown as Record<string, unknown>).msAgentRawEventChannel = {
                appendLine: (line: string) => lines.push(line),
                show: () => {},
                dispose: () => {},
            };
            getRawEventChannel().appendLine('recovered');
            expect(lines).to.deep.equal(['recovered']);
        });
    });

    describe('logRawEvent', () => {
        it('emits exactly one timestamped line per event', () => {
            const { lines } = _installFakeRawEventChannelForTests();
            logRawEvent(
                { type: 'message.part.updated', properties: { part: { tool: 'grep' } } },
                { runnerSessionId: 'ses_abc', disposition: 'emit' },
            );
            expect(lines.length).to.equal(1);
            expect(lines[0]).to.match(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /);
        });

        it('includes the runner session scope, disposition, type, and verbatim JSON', () => {
            const { lines } = _installFakeRawEventChannelForTests();
            const event = { type: 'message.part.updated', properties: { part: { tool: 'grep' } } };
            logRawEvent(event, { runnerSessionId: 'ses_abc', disposition: 'emit' });
            expect(lines[0]).to.contain('[ses_abc]');
            expect(lines[0]).to.contain(' emit ');
            expect(lines[0]).to.contain('message.part.updated');
            expect(lines[0]).to.contain(` :: ${JSON.stringify(event)}`);
        });

        it('uses the "starting" scope before a session id is known', () => {
            const { lines } = _installFakeRawEventChannelForTests();
            logRawEvent({ type: 'server.connected' }, { disposition: 'buffered' });
            expect(lines[0]).to.contain('[starting]');
            expect(lines[0]).to.contain(' buffered ');

            logRawEvent({ type: 'server.connected' }, { runnerSessionId: null, disposition: 'buffered' });
            expect(lines[1]).to.contain('[starting]');
        });

        it('records the skip disposition for foreign-session events', () => {
            const { lines } = _installFakeRawEventChannelForTests();
            logRawEvent(
                { type: 'message.updated', properties: { sessionID: 'ses_other' } },
                { runnerSessionId: 'ses_mine', disposition: 'skip' },
            );
            expect(lines[0]).to.contain('[ses_mine]');
            expect(lines[0]).to.contain(' skip ');
            expect(lines[0]).to.contain('ses_other');
        });

        it('caps oversized events so a single line cannot flood the channel', () => {
            const { lines } = _installFakeRawEventChannelForTests();
            logRawEvent(
                { type: 'tool', output: 'y'.repeat(30000) },
                { runnerSessionId: 'ses_abc', disposition: 'emit' },
            );
            expect(lines.length).to.equal(1);
            expect(lines[0]).to.contain('… [truncated ');
            expect(lines[0].length).to.be.lessThan(21000);
        });

        it('logs unknown server-wide frames without throwing (server.heartbeat trap)', () => {
            const { lines } = _installFakeRawEventChannelForTests();
            expect(() =>
                logRawEvent({ type: 'server.heartbeat', properties: {} }, { disposition: 'skip' }),
            ).to.not.throw();
            expect(lines[0]).to.contain('server.heartbeat');
        });
    });
});
