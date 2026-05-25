import { expect } from 'chai';
import * as sinon from 'sinon';
import { QueueEventEmitter } from './queueEvents';
import type { QueueStateItem, QueueSummary } from '../webview/messages';

function makeItem(overrides: Partial<QueueStateItem> = {}): QueueStateItem {
    return {
        id: overrides.id ?? 't1',
        group: overrides.group ?? 'queued',
        title: overrides.title ?? 'Task',
        ...overrides,
    };
}

function makeSummary(over: Partial<QueueSummary> = {}): QueueSummary {
    return {
        paused: false,
        hasPendingTasks: true,
        runningCount: 0,
        queuedCount: 0,
        completedCount: 0,
        ...over,
    };
}

describe('QueueEventEmitter', () => {
    let summary: QueueSummary;
    beforeEach(() => {
        summary = makeSummary();
    });

    it('coalesces multiple added for the same id into one entry (last write wins)', () => {
        const emitter = new QueueEventEmitter(() => summary);
        const sink = sinon.stub();
        emitter.subscribe(sink);
        emitter.added(makeItem({ id: 'a', title: 'first' }));
        emitter.added(makeItem({ id: 'a', title: 'second' }));
        emitter.flushNow();
        expect(sink.callCount).to.equal(1);
        const delta = sink.firstCall.args[0];
        expect(delta.added).to.have.lengthOf(1);
        expect(delta.added[0].title).to.equal('second');
        expect(delta.removed ?? []).to.be.empty;
        expect(delta.updated ?? []).to.be.empty;
    });

    it('added then removed in the same tick collapses to a no-op', () => {
        const emitter = new QueueEventEmitter(() => summary);
        const sink = sinon.stub();
        emitter.subscribe(sink);
        emitter.added(makeItem({ id: 'a' }));
        emitter.removed('a');
        emitter.flushNow();
        expect(sink.callCount).to.equal(0);
    });

    it('multiple updated for the same id merge into one entry', () => {
        const emitter = new QueueEventEmitter(() => summary);
        const sink = sinon.stub();
        emitter.subscribe(sink);
        emitter.updated('a', { title: 'first' });
        emitter.updated('a', { opencodeSessionId: 'sess1' });
        emitter.flushNow();
        const delta = sink.firstCall.args[0];
        expect(delta.updated).to.have.lengthOf(1);
        expect(delta.updated[0]).to.deep.include({ id: 'a', title: 'first', opencodeSessionId: 'sess1' });
    });

    it('removed then added for the same id becomes a final-state added', () => {
        const emitter = new QueueEventEmitter(() => summary);
        const sink = sinon.stub();
        emitter.subscribe(sink);
        emitter.removed('a');
        emitter.added(makeItem({ id: 'a', title: 'reborn' }));
        emitter.flushNow();
        const delta = sink.firstCall.args[0];
        expect(delta.added).to.have.lengthOf(1);
        expect(delta.added[0].title).to.equal('reborn');
        expect(delta.removed ?? []).to.be.empty;
    });

    it('flushNow without any pending mutations does not call subscribers', () => {
        const emitter = new QueueEventEmitter(() => summary);
        const sink = sinon.stub();
        emitter.subscribe(sink);
        emitter.flushNow();
        expect(sink.callCount).to.equal(0);
    });

    it('subscriber exception clears dirty state and does not poison the next flush', () => {
        const emitter = new QueueEventEmitter(() => summary);
        const sandbox = sinon.createSandbox();
        sandbox.stub(console, 'error');  // silence expected log
        try {
            const sink = sinon.stub()
                .onFirstCall().throws(new Error('boom'))
                .onSecondCall().returns(undefined);
            emitter.subscribe(sink);
            emitter.added(makeItem({ id: 'a' }));
            expect(() => emitter.flushNow()).to.not.throw();
            emitter.added(makeItem({ id: 'b' }));
            emitter.flushNow();
            expect(sink.callCount).to.equal(2);
            const secondDelta = sink.secondCall.args[0];
            expect(secondDelta.added).to.have.lengthOf(1);
            expect(secondDelta.added[0].id).to.equal('b');
        } finally {
            sandbox.restore();
        }
    });

    it('update after remove in the same tick is ignored', () => {
        const emitter = new QueueEventEmitter(() => summary);
        const sink = sinon.stub();
        emitter.subscribe(sink);
        emitter.removed('a');
        emitter.updated('a', { title: 'too late' });
        emitter.flushNow();
        expect(sink.callCount).to.equal(1);
        const delta = sink.firstCall.args[0];
        expect(delta.removed).to.deep.equal(['a']);
        expect(delta.updated ?? []).to.be.empty;
    });

    it('a throwing subscriber does not block sibling subscribers in the same tick', () => {
        const emitter = new QueueEventEmitter(() => summary);
        const sandbox = sinon.createSandbox();
        sandbox.stub(console, 'error');  // silence expected log
        try {
            const bad = sinon.stub().throws(new Error('boom'));
            const good = sinon.stub();
            emitter.subscribe(bad);
            emitter.subscribe(good);
            emitter.added(makeItem({ id: 'a' }));
            emitter.flushNow();
            expect(bad.callCount).to.equal(1);
            expect(good.callCount).to.equal(1);
            expect(good.firstCall.args[0].added).to.have.lengthOf(1);
        } finally {
            sandbox.restore();
        }
    });
});
