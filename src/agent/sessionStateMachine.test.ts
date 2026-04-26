import { expect } from 'chai';
import { SessionStateMachine } from './sessionStateMachine';

describe('SessionStateMachine', () => {
    it('allows a hard terminal event directly from sending', () => {
        const sm = new SessionStateMachine();

        expect(sm.dispatch({ kind: 'START', detail: 'server' })).to.equal(true);
        expect(sm.state()).to.equal('sending');

        expect(sm.dispatch({ kind: 'TERMINAL_EVENT', reason: 'done' })).to.equal(true);
        expect(sm.state()).to.equal('applying_patch');
    });

    it('allows a hard terminal event while awaiting a tool result', () => {
        const sm = new SessionStateMachine();

        expect(sm.dispatch({ kind: 'START', detail: 'server' })).to.equal(true);
        expect(sm.dispatch({ kind: 'TOOL_CALL', name: 'edit_file', toolCallId: 'tc_1' })).to.equal(true);
        expect(sm.state()).to.equal('awaiting_tool');

        expect(sm.dispatch({ kind: 'TERMINAL_EVENT', reason: 'done' })).to.equal(true);
        expect(sm.state()).to.equal('applying_patch');
    });
});
