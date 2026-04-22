import { expect } from 'chai';
import {
  createInitialState,
  reduceSessionState,
  formatDiffToLines,
  computeChangeSummary,
  phaseToTimelineType,
  SessionState,
  TimelineStep,
} from './sessionState';
import { WebviewMessage } from '../webview/messages';

describe('sessionState', () => {
  describe('createInitialState', () => {
    it('returns correct defaults', () => {
      const state = createInitialState();
      expect(state.backend).to.equal('');
      expect(state.mode).to.equal('');
      expect(state.degraded).to.be.false;
      expect(state.phase).to.equal('idle');
      expect(state.phaseMessage).to.equal('');
      expect(state.steps).to.deep.equal([]);
      expect(state.diffCards).to.deep.equal([]);
      expect(state.completed).to.be.false;
      expect(state.success).to.be.undefined;
      expect(state.finalMessage).to.equal('');
      expect(state.startedAt).to.equal(0);
    });
  });

  describe('reduceSessionState', () => {
    it('session_start initializes backend, mode, startedAt, clears completed', () => {
      const msg: WebviewMessage = {
        type: 'session_start',
        payload: { backend: 'openai', mode: 'fix' },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.backend).to.equal('openai');
      expect(state.mode).to.equal('fix');
      expect(state.completed).to.be.false;
      expect(state.startedAt).to.be.greaterThan(0);
    });

    it('backend_info updates backend, mode, degraded flag', () => {
      const msg: WebviewMessage = {
        type: 'backend_info',
        payload: { backend: 'ollama', mode: 'builtin', degraded: true },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.backend).to.equal('ollama');
      expect(state.mode).to.equal('builtin');
      expect(state.degraded).to.be.true;
    });

    it('status updates phase and phaseMessage', () => {
      const msg: WebviewMessage = {
        type: 'status',
        payload: { phase: 'planning', message: 'Analyzing error...' },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.phase).to.equal('planning');
      expect(state.phaseMessage).to.equal('Analyzing error...');
    });

    it('step_update appends a new timeline step', () => {
      const msg: WebviewMessage = {
        type: 'step_update',
        payload: { step: 'reading_files', detail: 'Reading add_custom.cpp' },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.steps).to.have.length(1);
      expect(state.steps[0].type).to.equal('reading_files');
      expect(state.steps[0].title).to.equal('reading_files');
      expect(state.steps[0].detail).to.equal('Reading add_custom.cpp');
      expect(state.steps[0].status).to.equal('running');
    });

    it('tool_call followed by tool_result merges correctly', () => {
      const toolCallMsg: WebviewMessage = {
        type: 'tool_call',
        payload: {
          messageId: 'm1',
          toolCallId: 'tc1',
          name: 'read_file',
          params: { path: 'a.cpp' },
        },
      };
      const stateAfterCall = reduceSessionState(createInitialState(), toolCallMsg);
      expect(stateAfterCall.steps).to.have.length(1);
      expect(stateAfterCall.steps[0].type).to.equal('tool_call');
      expect(stateAfterCall.steps[0].status).to.equal('running');
      expect(stateAfterCall.steps[0].id).to.equal('tc1');

      const toolResultMsg: WebviewMessage = {
        type: 'tool_result',
        payload: {
          toolCallId: 'tc1',
          result: 'file content',
          isError: false,
        },
      };
      const stateAfterResult = reduceSessionState(stateAfterCall, toolResultMsg);
      expect(stateAfterResult.steps).to.have.length(1);
      expect(stateAfterResult.steps[0].status).to.equal('success');
    });

    it('tool_result with isError=true updates step to error', () => {
      const toolCallMsg: WebviewMessage = {
        type: 'tool_call',
        payload: {
          messageId: 'm1',
          toolCallId: 'tc1',
          name: 'edit_file',
          params: { path: 'a.cpp' },
        },
      };
      const state = reduceSessionState(createInitialState(), toolCallMsg);
      const toolResultMsg: WebviewMessage = {
        type: 'tool_result',
        payload: {
          toolCallId: 'tc1',
          result: 'failed',
          isError: true,
        },
      };
      const finalState = reduceSessionState(state, toolResultMsg);
      expect(finalState.steps[0].status).to.equal('error');
    });

    it('diff adds a diff card with correct changeSummary', () => {
      const msg: WebviewMessage = {
        type: 'diff',
        payload: {
          path: 'src/test.cpp',
          oldText: 'line1\nline2\nline3',
          newText: 'line1\nmodified\nline3',
          toolCallId: 'tc1',
        },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.diffCards).to.have.length(1);
      expect(state.diffCards[0].path).to.equal('src/test.cpp');
      expect(state.diffCards[0].oldText).to.equal('line1\nline2\nline3');
      expect(state.diffCards[0].newText).to.equal('line1\nmodified\nline3');
      expect(state.diffCards[0].changeSummary).to.equal('1 addition, 1 deletion');
    });

    it('final_diff updates existing diff card by path', () => {
      const diffMsg: WebviewMessage = {
        type: 'diff',
        payload: {
          path: 'src/test.cpp',
          oldText: 'old',
          newText: 'new',
          toolCallId: 'tc1',
        },
      };
      const state1 = reduceSessionState(createInitialState(), diffMsg);

      const finalDiffMsg: WebviewMessage = {
        type: 'final_diff',
        payload: {
          path: 'src/test.cpp',
          oldContent: 'final old',
          newContent: 'final new',
          message: 'Final diff',
        },
      };
      const state2 = reduceSessionState(state1, finalDiffMsg);
      expect(state2.diffCards).to.have.length(1);
      expect(state2.diffCards[0].oldText).to.equal('final old');
      expect(state2.diffCards[0].newText).to.equal('final new');
      expect(state2.diffCards[0].changeSummary).to.equal('1 addition, 1 deletion');
    });

    it('final_diff adds new diff card if path does not exist', () => {
      const finalDiffMsg: WebviewMessage = {
        type: 'final_diff',
        payload: {
          path: 'src/other.cpp',
          oldContent: 'a',
          newContent: 'b',
          message: 'Final diff',
        },
      };
      const state = reduceSessionState(createInitialState(), finalDiffMsg);
      expect(state.diffCards).to.have.length(1);
      expect(state.diffCards[0].path).to.equal('src/other.cpp');
    });

    it('session_end sets completed, success, and finalMessage', () => {
      const msg: WebviewMessage = {
        type: 'session_end',
        payload: { success: true, finalMessage: 'Fix applied!' },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.completed).to.be.true;
      expect(state.success).to.be.true;
      expect(state.finalMessage).to.equal('Fix applied!');
    });

    it('error message sets phase to error and appends error step', () => {
      const msg: WebviewMessage = {
        type: 'error',
        payload: { message: 'Something went wrong' },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.phase).to.equal('error');
      expect(state.steps).to.have.length(1);
      expect(state.steps[0].type).to.equal('failed');
      expect(state.steps[0].title).to.equal('Error');
      expect(state.steps[0].detail).to.equal('Something went wrong');
      expect(state.steps[0].status).to.equal('error');
    });

    it('clear resets to initial state', () => {
      const startMsg: WebviewMessage = {
        type: 'session_start',
        payload: { backend: 'openai', mode: 'fix' },
      };
      const state1 = reduceSessionState(createInitialState(), startMsg);
      const clearMsg: WebviewMessage = {
        type: 'clear',
        payload: {},
      };
      const state2 = reduceSessionState(state1, clearMsg);
      expect(state2).to.deep.equal(createInitialState());
    });

    it('degraded=true in backend_info is preserved', () => {
      const msg: WebviewMessage = {
        type: 'backend_info',
        payload: { backend: 'ollama', mode: 'builtin', degraded: true },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.degraded).to.be.true;
    });

    it('degraded=false in backend_info is preserved', () => {
      const msg: WebviewMessage = {
        type: 'backend_info',
        payload: { backend: 'ollama', mode: 'builtin', degraded: false },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.degraded).to.be.false;
    });

    it('does not mutate input state', () => {
      const initial = createInitialState();
      const msg: WebviewMessage = {
        type: 'status',
        payload: { phase: 'planning' },
      };
      const next = reduceSessionState(initial, msg);
      expect(initial.phase).to.equal('idle');
      expect(next.phase).to.equal('planning');
    });
  });

  describe('formatDiffToLines', () => {
    it('produces expected patch output for simple change', () => {
      const oldText = 'line1\nline2\nline3\nline4\nline5';
      const newText = 'line1\nline2\nmodified\nline4\nline5';
      const result = formatDiffToLines(oldText, newText);
      expect(result.length).to.be.greaterThan(0);
      const addLine = result.find((l) => l.type === 'add');
      const removeLine = result.find((l) => l.type === 'remove');
      expect(addLine).to.exist;
      expect(addLine!.text).to.equal('modified');
      expect(removeLine).to.exist;
      expect(removeLine!.text).to.equal('line3');
    });

    it('includes context lines around changes', () => {
      const oldText = 'a\nb\nc\nd\ne';
      const newText = 'a\nb\nCHANGED\nd\ne';
      const result = formatDiffToLines(oldText, newText);
      const contextTexts = result.filter((l) => l.type === 'context').map((l) => l.text);
      expect(contextTexts).to.include('a');
      expect(contextTexts).to.include('b');
      expect(contextTexts).to.include('d');
      expect(contextTexts).to.include('e');
    });

    it('handles identical texts', () => {
      const text = 'line1\nline2\nline3';
      const result = formatDiffToLines(text, text);
      expect(result).to.deep.equal([
        { type: 'context', text: 'line1', oldNum: 1, newNum: 1 },
        { type: 'context', text: 'line2', oldNum: 2, newNum: 2 },
        { type: 'context', text: 'line3', oldNum: 3, newNum: 3 },
      ]);
    });

    it('handles empty old text', () => {
      const result = formatDiffToLines('', 'line1\nline2');
      expect(result.filter((l) => l.type === 'add')).to.have.length(2);
    });

    it('handles empty new text', () => {
      const result = formatDiffToLines('line1\nline2', '');
      expect(result.filter((l) => l.type === 'remove')).to.have.length(2);
    });

    it('assigns line numbers correctly', () => {
      const oldText = 'a\nb\nc';
      const newText = 'a\nX\nc';
      const result = formatDiffToLines(oldText, newText);
      const removeLine = result.find((l) => l.type === 'remove');
      const addLine = result.find((l) => l.type === 'add');
      expect(removeLine!.oldNum).to.equal(2);
      expect(addLine!.newNum).to.equal(2);
    });
  });

  describe('computeChangeSummary', () => {
    it('returns correct summary for additions and deletions', () => {
      const oldText = 'line1\nline2\nline3';
      const newText = 'line1\nmodified\nline3\nline4';
      const summary = computeChangeSummary(oldText, newText);
      expect(summary).to.equal('2 additions, 1 deletion');
    });

    it('returns zero counts for identical text', () => {
      const text = 'line1\nline2';
      const summary = computeChangeSummary(text, text);
      expect(summary).to.equal('0 additions, 0 deletions');
    });

    it('handles all additions', () => {
      const summary = computeChangeSummary('', 'a\nb');
      expect(summary).to.equal('2 additions, 0 deletions');
    });

    it('handles all deletions', () => {
      const summary = computeChangeSummary('a\nb', '');
      expect(summary).to.equal('0 additions, 2 deletions');
    });
  });

  describe('phaseToTimelineType', () => {
    it('maps known phases correctly', () => {
      expect(phaseToTimelineType('planning')).to.equal('planning');
      expect(phaseToTimelineType('reading_files')).to.equal('reading_files');
      expect(phaseToTimelineType('calling_tools')).to.equal('calling_tools');
      expect(phaseToTimelineType('editing')).to.equal('editing');
      expect(phaseToTimelineType('verifying')).to.equal('verifying');
      expect(phaseToTimelineType('completed')).to.equal('completed');
      expect(phaseToTimelineType('failed')).to.equal('failed');
      expect(phaseToTimelineType('cancelled')).to.equal('cancelled');
    });

    it('returns calling_tools for unknown phases', () => {
      expect(phaseToTimelineType('unknown_phase')).to.equal('calling_tools');
    });

    it('returns calling_tools for empty string', () => {
      expect(phaseToTimelineType('')).to.equal('calling_tools');
    });
  });
});
