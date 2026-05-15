import { expect } from 'chai';
import {
    abbreviateParams,
    formatElapsed,
    formatTimestamp,
    getActivityChannel,
    logActivity,
    logCancelled,
    logRetry,
    logRunEnd,
    logRunStart,
    logRunTimeout,
    logServerNotice,
    logServerReady,
    logServerStarting,
    logSessionOpened,
    logStall,
    logTextProgress,
    logToolCall,
    logToolResult,
    _installFakeActivityChannelForTests,
    _resetActivityChannelForTests,
} from './activityChannel';

describe('activityChannel', () => {
    afterEach(() => {
        _resetActivityChannelForTests();
    });

    describe('formatTimestamp', () => {
        it('formats a known time as HH:MM:SS.mmm', () => {
            const fixed = new Date(2026, 4, 15, 9, 5, 7, 42);
            expect(formatTimestamp(fixed)).to.equal('09:05:07.042');
        });

        it('pads single-digit fields with zeros', () => {
            const fixed = new Date(2026, 0, 1, 0, 0, 0, 0);
            expect(formatTimestamp(fixed)).to.equal('00:00:00.000');
        });
    });

    describe('formatElapsed', () => {
        it('returns ms for sub-second values', () => {
            expect(formatElapsed(0)).to.equal('0ms');
            expect(formatElapsed(150)).to.equal('150ms');
            expect(formatElapsed(999)).to.equal('999ms');
        });

        it('returns seconds with one decimal between 1s and 60s', () => {
            expect(formatElapsed(1000)).to.equal('1.0s');
            expect(formatElapsed(1234)).to.equal('1.2s');
            expect(formatElapsed(59999)).to.equal('59.9s');
        });

        it('returns minutes and seconds at or above 60s', () => {
            expect(formatElapsed(60000)).to.equal('1m00s');
            expect(formatElapsed(125000)).to.equal('2m05s');
            expect(formatElapsed(600000)).to.equal('10m00s');
        });

        it('handles negative or non-finite values', () => {
            expect(formatElapsed(-1)).to.equal('unknown');
            expect(formatElapsed(NaN)).to.equal('unknown');
            expect(formatElapsed(Infinity)).to.equal('unknown');
        });
    });

    describe('abbreviateParams', () => {
        it('returns empty string for null/undefined', () => {
            expect(abbreviateParams(null)).to.equal('');
            expect(abbreviateParams(undefined)).to.equal('');
        });

        it('serializes simple objects under the limit', () => {
            expect(abbreviateParams({ pattern: 'foo' })).to.equal('{"pattern":"foo"}');
        });

        it('truncates long params and appends ellipsis', () => {
            const long = { value: 'x'.repeat(500) };
            const result = abbreviateParams(long, 60);
            expect(result.length).to.equal(60);
            expect(result.endsWith('...')).to.equal(true);
        });

        it('handles non-serializable values without throwing', () => {
            const cyclic: any = {};
            cyclic.self = cyclic;
            expect(abbreviateParams(cyclic)).to.equal('[unserializable]');
        });
    });

    describe('getActivityChannel fallback', () => {
        it('falls back to a no-op console-backed channel when nothing is installed', () => {
            const channel = getActivityChannel();
            // Should not throw on any operation.
            expect(() => channel.appendLine('hello')).to.not.throw();
            expect(() => channel.show(true)).to.not.throw();
            expect(() => channel.dispose()).to.not.throw();
        });
    });

    describe('typed log helpers', () => {
        it('logRunStart emits a separator, banner line, and metadata lines', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logRunStart({
                file: 'foo.cpp',
                line: 42,
                errorType: 'OUT_OF_BOUNDS',
                model: 'opencode/test',
                timeoutMs: 300000,
            });
            expect(lines.length).to.equal(6); // blank, separator, banner, error, model, timeout
            expect(lines[0]).to.equal('');
            expect(lines[1]).to.match(/^─+$/);
            expect(lines[2]).to.contain('▶ Fix started');
            expect(lines[2]).to.contain('foo.cpp:42');
            expect(lines[3]).to.contain('error: OUT_OF_BOUNDS');
            expect(lines[4]).to.contain('model: opencode/test');
            expect(lines[5]).to.contain('timeout: 5m00s');
        });

        it('logToolCall emits a "running" line with name and abbreviated params', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logToolCall({
                name: 'grep',
                params: { pattern: 'foo', glob: '**/*.cpp' },
                toolCallId: 'call_123',
            });
            expect(lines.length).to.equal(1);
            expect(lines[0]).to.contain('▶ tool: grep');
            expect(lines[0]).to.contain('pattern');
            expect(lines[0]).to.contain('— running…');
        });

        it('logToolCall omits the parens when params are empty (deferred-input case)', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logToolCall({ name: 'grep', params: {}, toolCallId: 'call_123' });
            expect(lines[0]).to.contain('▶ tool: grep —');
            expect(lines[0]).to.not.contain('grep(');
            expect(lines[0]).to.not.contain('grep()');
        });

        it('logToolResult uses ✓ for success and includes elapsed + size', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logToolResult({
                name: 'grep',
                toolCallId: 'call_123',
                isError: false,
                elapsedMs: 1234,
                resultChars: 4096,
            });
            expect(lines[0]).to.contain('✓ tool: grep');
            expect(lines[0]).to.contain('1.2s');
            expect(lines[0]).to.contain('4096 chars');
        });

        it('logToolResult includes the resolved params on the result line when known', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logToolResult({
                name: 'grep',
                toolCallId: 'call_123',
                isError: false,
                elapsedMs: 100,
                resultChars: 50,
                params: { pattern: 'foo' },
            });
            expect(lines[0]).to.contain('✓ tool: grep({"pattern":"foo"}) returned');
        });

        it('logToolResult omits parens on the result line when params is {}', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logToolResult({
                name: 'grep',
                toolCallId: 'call_123',
                isError: false,
                elapsedMs: 100,
                resultChars: 50,
                params: {},
            });
            expect(lines[0]).to.contain('✓ tool: grep returned');
            expect(lines[0]).to.not.contain('grep({})');
        });

        it('logToolResult uses ✗ for errors and includes the error preview', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logToolResult({
                name: 'grep',
                toolCallId: 'call_123',
                isError: true,
                elapsedMs: 50,
                resultChars: 12,
                errorPreview: 'permission denied',
            });
            expect(lines[0]).to.contain('✗ tool: grep failed');
            expect(lines[0]).to.contain('50ms');
            expect(lines[0]).to.contain('permission denied');
        });

        it('logStall reports the in-flight tool when one is provided', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logStall({
                sinceLastEventMs: 30000,
                inFlightToolName: 'grep',
                inFlightToolElapsedMs: 45000,
                smState: 'awaiting_tool',
            });
            expect(lines[0]).to.contain('⏳ still waiting on tool \'grep\'');
            expect(lines[0]).to.contain('45.0s');
            expect(lines[0]).to.contain('30.0s');
        });

        it('logStall reports plain silence when no tool is in-flight', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logStall({
                sinceLastEventMs: 20000,
                smState: 'streaming',
            });
            expect(lines[0]).to.contain('⏳ no events for 20.0s');
            expect(lines[0]).to.contain('streaming');
        });

        it('logRunTimeout pinpoints the stuck tool when known', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logRunTimeout(600000, 540000, 'grep');
            expect(lines[0]).to.contain('⏱ timed out after 10m00s');
            expect(lines[1]).to.contain('tool \'grep\'');
            expect(lines[1]).to.contain('9m00s');
        });

        it('logRunTimeout falls back to silence reporting when no tool is known', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logRunTimeout(60000, 30000, undefined);
            expect(lines[0]).to.contain('⏱ timed out after 1m00s');
            expect(lines[1]).to.contain('no events for 30.0s');
        });

        it('logRunEnd writes outcome-specific symbol and a closing separator', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logRunEnd({
                outcome: 'applied',
                finalMessage: 'Problem: ...\nFix: ...',
                fileChanged: true,
                toolCallCount: 3,
                elapsedMs: 12500,
            });
            expect(lines[0]).to.contain('✓ Fix applied');
            expect(lines[0]).to.contain('3 tool calls');
            expect(lines[0]).to.contain('12.5s');
            expect(lines[1]).to.contain('Problem');
            expect(lines[2]).to.match(/^─+$/);
        });

        it('logRunEnd handles failed outcome', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logRunEnd({
                outcome: 'failed',
                finalMessage: 'Transport error: timed out',
                fileChanged: false,
                toolCallCount: 1,
                elapsedMs: 600000,
            });
            expect(lines[0]).to.contain('✗ Fix failed');
            expect(lines[0]).to.contain('1 tool call');
            expect(lines[0]).to.contain('10m00s');
        });

        it('logRunEnd handles no_change outcome', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logRunEnd({
                outcome: 'no_change',
                finalMessage: 'Already correct',
                fileChanged: false,
                toolCallCount: 0,
                elapsedMs: 5000,
            });
            expect(lines[0]).to.contain('· No fix needed');
            expect(lines[0]).to.contain('0 tool calls');
        });

        it('logServerStarting / logServerReady / logServerNotice route to the channel', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logServerStarting(4096);
            logServerReady(4096);
            logServerNotice('listening on http://127.0.0.1:4096');
            expect(lines[0]).to.contain('Starting OpenCode server on port 4096');
            expect(lines[1]).to.contain('OpenCode server ready on port 4096');
            expect(lines[2]).to.contain('server: listening');
        });

        it('logSessionOpened emits one line with id and model', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logSessionOpened('ses_abc', 'opencode/foo');
            expect(lines[0]).to.contain('Session opened (ses_abc)');
            expect(lines[0]).to.contain('opencode/foo');
        });

        it('logCancelled emits a single cancellation line', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logCancelled();
            expect(lines[0]).to.contain('✗ cancelled by user');
        });

        it('logRetry emits a one-line retry message', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logRetry('OpenCode finished without a native edit; original file preserved');
            expect(lines[0]).to.contain('↻ retrying');
            expect(lines[0]).to.contain('without a native edit');
        });

        it('logRetry truncates very long reasons', () => {
            const { lines } = _installFakeActivityChannelForTests();
            const reason = 'x'.repeat(400);
            logRetry(reason);
            // The body of the line (after the timestamp + arrow) shouldn't blow past ~200 chars.
            expect(lines[0].length).to.be.lessThan(200);
            expect(lines[0].endsWith('...')).to.equal(true);
        });

        it('logTextProgress reports a streaming milestone', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logTextProgress(5000);
            expect(lines[0]).to.contain('streaming response (5000 chars');
        });

        it('logActivity prefixes lines with HH:MM:SS.mmm', () => {
            const { lines } = _installFakeActivityChannelForTests();
            logActivity('hello');
            expect(lines[0]).to.match(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] hello$/);
        });
    });
});
