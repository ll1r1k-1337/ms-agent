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
      expect(state.model).to.equal('');
      expect(state.opencodeSessionId).to.equal('');
      expect(state.degraded).to.be.false;
      expect(state.phase).to.equal('idle');
      expect(state.phaseMessage).to.equal('');
      expect(state.steps).to.deep.equal([]);
      expect(state.diffCards).to.deep.equal([]);
      expect(state.completed).to.be.false;
      expect(state.success).to.be.undefined;
      expect(state.outcome).to.be.undefined;
      expect(state.finalMessage).to.equal('');
      expect(state.startedAt).to.equal(0);
    });
  });

  describe('reduceSessionState', () => {
    it('session_start initializes backend, mode, startedAt, clears completed', () => {
      const msg: WebviewMessage = {
        type: 'session_start',
        payload: { backend: 'openai', mode: 'fix', model: 'volcengine-plan/doubao-seed-2.0-code' },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.backend).to.equal('openai');
      expect(state.mode).to.equal('fix');
      expect(state.model).to.equal('volcengine-plan/doubao-seed-2.0-code');
      expect(state.completed).to.be.false;
      expect(state.startedAt).to.be.greaterThan(0);
    });

    it('backend_info updates backend and mode', () => {
      const msg: WebviewMessage = {
        type: 'backend_info',
        payload: { backend: 'ollama', mode: 'builtin', model: 'opencode/big-pickle', degraded: true },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.backend).to.equal('ollama');
      expect(state.mode).to.equal('builtin');
      expect(state.model).to.equal('opencode/big-pickle');
      expect(state.degraded).to.be.false;
    });

    it('session_metadata stores the OpenCode session id', () => {
      const msg: WebviewMessage = {
        type: 'session_metadata',
        payload: { opencodeSessionId: 'ses_abc123' },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.opencodeSessionId).to.equal('ses_abc123');
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
        payload: { success: true, outcome: 'applied', finalMessage: 'Fix applied!' },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.completed).to.be.true;
      expect(state.success).to.be.true;
      expect(state.outcome).to.equal('applied');
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

    it('degraded=true in backend_info is ignored in OpenCode-only mode', () => {
      const msg: WebviewMessage = {
        type: 'backend_info',
        payload: { backend: 'ollama', mode: 'builtin', degraded: true },
      };
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.degraded).to.be.false;
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

    it('tool_result for non-existent toolCallId silently does nothing', () => {
      const toolCallMsg: WebviewMessage = {
        type: 'tool_call',
        payload: {
          messageId: 'm1',
          toolCallId: 'tc1',
          name: 'read_file',
          params: { path: 'a.cpp' },
        },
      };
      const state = reduceSessionState(createInitialState(), toolCallMsg);

      const toolResultMsg: WebviewMessage = {
        type: 'tool_result',
        payload: {
          toolCallId: 'nonexistent',
          result: 'file content',
          isError: false,
        },
      };
      const finalState = reduceSessionState(state, toolResultMsg);
      expect(finalState.steps).to.have.length(1);
      expect(finalState.steps[0].id).to.equal('tc1');
      expect(finalState.steps[0].status).to.equal('running');
    });

    it('error message does not set completed or success', () => {
      const startMsg: WebviewMessage = {
        type: 'session_start',
        payload: { backend: 'openai', mode: 'fix' },
      };
      const state1 = reduceSessionState(createInitialState(), startMsg);

      const errorMsg: WebviewMessage = {
        type: 'error',
        payload: { message: 'Something went wrong' },
      };
      const state2 = reduceSessionState(state1, errorMsg);
      expect(state2.phase).to.equal('error');
      expect(state2.steps).to.have.length(1);
      expect(state2.steps[0].type).to.equal('failed');
      expect(state2.completed).to.be.false;
      expect(state2.success).to.be.undefined;
    });

    it('session_start mid-session resets startedAt and clears completed', () => {
      let mockNow = 1000;
      const originalDateNow = Date.now;
      Date.now = () => mockNow++;

      const startMsg1: WebviewMessage = {
        type: 'session_start',
        payload: { backend: 'openai', mode: 'fix' },
      };
      const state1 = reduceSessionState(createInitialState(), startMsg1);
      const firstStartedAt = state1.startedAt;

      const endMsg: WebviewMessage = {
        type: 'session_end',
        payload: { success: true, outcome: 'applied', finalMessage: 'Done' },
      };
      const state2 = reduceSessionState(state1, endMsg);
      expect(state2.completed).to.be.true;

      const startMsg2: WebviewMessage = {
        type: 'session_start',
        payload: { backend: 'ollama', mode: 'chat' },
      };
      const state3 = reduceSessionState(state2, startMsg2);
      Date.now = originalDateNow;

      expect(state3.completed).to.be.false;
      expect(state3.success).to.be.undefined;
      expect(state3.outcome).to.be.undefined;
      expect(state3.startedAt).to.be.greaterThan(0);
      expect(state3.startedAt).to.not.equal(firstStartedAt);
      expect(state3.backend).to.equal('ollama');
      expect(state3.mode).to.equal('chat');
    });

    it('backend_info with missing degraded defaults to false', () => {
      const msg = {
        type: 'backend_info',
        payload: { backend: 'ollama', mode: 'builtin' },
      } as WebviewMessage;
      const state = reduceSessionState(createInitialState(), msg);
      expect(state.degraded).to.be.false;
    });

    it('multiple step_updates create multiple steps', () => {
      const msg1: WebviewMessage = {
        type: 'step_update',
        payload: { step: 'reading_files', detail: 'Reading a.cpp' },
      };
      const msg2: WebviewMessage = {
        type: 'step_update',
        payload: { step: 'calling_tools', detail: 'Calling tools' },
      };
      const msg3: WebviewMessage = {
        type: 'step_update',
        payload: { step: 'editing', detail: 'Editing files' },
      };

      let state = reduceSessionState(createInitialState(), msg1);
      state = reduceSessionState(state, msg2);
      state = reduceSessionState(state, msg3);

      expect(state.steps).to.have.length(3);
      expect(state.steps[0].type).to.equal('reading_files');
      expect(state.steps[0].status).to.equal('running');
      expect(state.steps[1].type).to.equal('calling_tools');
      expect(state.steps[1].status).to.equal('running');
      expect(state.steps[2].type).to.equal('editing');
      expect(state.steps[2].status).to.equal('running');
    });

    it('diff followed by final_diff for same path updates card', () => {
      const diffMsg: WebviewMessage = {
        type: 'diff',
        payload: {
          path: 'a.cpp',
          oldText: 'old content',
          newText: 'new content',
          toolCallId: 'tc1',
        },
      };
      const state1 = reduceSessionState(createInitialState(), diffMsg);

      const finalDiffMsg: WebviewMessage = {
        type: 'final_diff',
        payload: {
          path: 'a.cpp',
          oldContent: 'final old',
          newContent: 'final new',
          message: 'Final diff',
        },
      };
      const state2 = reduceSessionState(state1, finalDiffMsg);
      expect(state2.diffCards).to.have.length(1);
      expect(state2.diffCards[0].path).to.equal('a.cpp');
      expect(state2.diffCards[0].oldText).to.equal('final old');
      expect(state2.diffCards[0].newText).to.equal('final new');
      expect(state2.diffCards[0].changeSummary).to.equal('1 addition, 1 deletion');
    });

    it('unknown message type leaves state unchanged', () => {
      const msg = { type: 'unknown_type', payload: { foo: 'bar' } } as unknown as WebviewMessage;
      const state = reduceSessionState(createInitialState(), msg);
      expect(state).to.deep.equal(createInitialState());
    });

    it('clear after session_start fully resets', () => {
      const messages: WebviewMessage[] = [
        { type: 'session_start', payload: { backend: 'openai', mode: 'fix' } },
        { type: 'status', payload: { phase: 'planning', message: 'Analyzing' } },
        { type: 'step_update', payload: { step: 'reading_files', detail: 'Reading a.cpp' } },
        {
          type: 'diff',
          payload: {
            path: 'a.cpp',
            oldText: 'old',
            newText: 'new',
            toolCallId: 'tc1',
          },
        },
      ];

      let state = createInitialState();
      for (const msg of messages) {
        state = reduceSessionState(state, msg);
      }
      expect(state.steps.length).to.be.greaterThan(0);
      expect(state.diffCards.length).to.be.greaterThan(0);
      expect(state.phase).to.equal('planning');

      const clearMsg: WebviewMessage = { type: 'clear', payload: {} };
      const cleared = reduceSessionState(state, clearMsg);
      expect(cleared).to.deep.equal(createInitialState());
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

    it('handles trailing newline as context', () => {
      const result = formatDiffToLines('a\n', 'a\n');
      expect(result).to.deep.equal([
        { type: 'context', text: 'a', oldNum: 1, newNum: 1 },
        { type: 'context', text: '', oldNum: 2, newNum: 2 },
      ]);
    });

    it('handles multiple separate change regions', () => {
      const oldText = 'a\nb\nc\nd\ne';
      const newText = 'a\nX\nc\nd\nY';
      const result = formatDiffToLines(oldText, newText);
      const addLines = result.filter((l) => l.type === 'add').map((l) => l.text);
      const removeLines = result.filter((l) => l.type === 'remove').map((l) => l.text);
      const contextTexts = result.filter((l) => l.type === 'context').map((l) => l.text);
      expect(addLines).to.include('X');
      expect(addLines).to.include('Y');
      expect(removeLines).to.include('b');
      expect(removeLines).to.include('e');
      expect(contextTexts).to.include('c');
      expect(contextTexts).to.include('d');
    });

    it('handles text with only additions at end', () => {
      const result = formatDiffToLines('a\nb', 'a\nb\nc\nd');
      const addLines = result.filter((l) => l.type === 'add');
      expect(addLines).to.have.length(2);
      expect(addLines[0].text).to.equal('c');
      expect(addLines[0].newNum).to.equal(3);
      expect(addLines[1].text).to.equal('d');
      expect(addLines[1].newNum).to.equal(4);
    });

    it('handles text with only deletions at end', () => {
      const result = formatDiffToLines('a\nb\nc', 'a\nb');
      const removeLines = result.filter((l) => l.type === 'remove');
      expect(removeLines).to.have.length(1);
      expect(removeLines[0].text).to.equal('c');
      expect(removeLines[0].oldNum).to.equal(3);
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

    it('handles trailing newline difference', () => {
      const summary = computeChangeSummary('a\n', 'a');
      expect(summary).to.equal('0 additions, 1 deletion');
    });

    it('handles single line modification', () => {
      const summary = computeChangeSummary('hello', 'world');
      expect(summary).to.equal('1 addition, 1 deletion');
    });

    it('handles empty strings', () => {
      const summary = computeChangeSummary('', '');
      expect(summary).to.equal('0 additions, 0 deletions');
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
