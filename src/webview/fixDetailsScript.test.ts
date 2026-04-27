import { expect } from 'chai';
import { fixDetailsScript } from './fixDetailsScript';

describe('fixDetailsScript string inclusion', () => {
  it('contains core function names', () => {
    expect(fixDetailsScript).to.include('handleMessage');
    expect(fixDetailsScript).to.include('appendTextStream');
    expect(fixDetailsScript).to.include('appendUserMessage');
    expect(fixDetailsScript).to.include('appendToolCall');
    expect(fixDetailsScript).to.include('appendToolResult');
    expect(fixDetailsScript).to.include('appendDiff');
    expect(fixDetailsScript).to.include('appendFinalDiff');
    expect(fixDetailsScript).to.include('completeMessage');
    expect(fixDetailsScript).to.include('updateStatus');
    expect(fixDetailsScript).to.include('appendSessionResult');
    expect(fixDetailsScript).to.include('clearAll');
    expect(fixDetailsScript).to.include('formatSimpleDiff');
    expect(fixDetailsScript).to.include('renderResult');
    expect(fixDetailsScript).to.include('updateQueueState');
  });

  it('contains card-based render entry points', () => {
    expect(fixDetailsScript).to.include('renderStatusCard');
    expect(fixDetailsScript).to.include('renderFiles');
    expect(fixDetailsScript).to.include('renderExplanation');
    expect(fixDetailsScript).to.include('renderIdleHint');
    expect(fixDetailsScript).to.include('renderInlineMarkdown');
    expect(fixDetailsScript).to.include('parseExplanationSections');
    expect(fixDetailsScript).to.include('explanationSectionHtml');
    expect(fixDetailsScript).to.include('formatDiffLines');
    expect(fixDetailsScript).to.include('renderCollapsedCards');
    expect(fixDetailsScript).to.include('toggleCardCollapse');
  });

  it('contains all DOM element IDs', () => {
    const ids = [
      'messages',
      'meta-target',
      'meta-model',
      'meta-session',
      'meta-backend',
      'meta-mode',
      'meta-elapsed',
      'status-pill',
      'status-label',
      'status-card',
      'status-progress',
      'elapsed-row',
      'queue-row',
      'queue-badge',
      'action-row',
      'files-card',
      'files-list',
      'files-meta',
      'explanation-card',
      'explanation-body',
      'explanation-meta',
      'idle-hint',
      'stopBtn',
      'cancelBtn',
    ];
    for (const id of ids) {
      expect(fixDetailsScript).to.include(id);
    }
  });

  it('contains message handler for all known message types', () => {
    const messageTypes = [
      'session_start',
      'session_metadata',
      'backend_info',
      'status',
      'step_update',
      'tool_call',
      'tool_result',
      'diff',
      'final_diff',
      'session_end',
      'error',
      'clear',
      'text_stream',
      'user_message',
      'message_complete',
      'queue_state',
    ];
    for (const type of messageTypes) {
      expect(fixDetailsScript).to.include("'" + type + "'");
    }
  });

  it('contains escapeHtml function', () => {
    expect(fixDetailsScript).to.include('function escapeHtml');
  });

  it('contains fix_details_ready message emission', () => {
    expect(fixDetailsScript).to.include('fix_details_ready');
  });

  it('contains acquireVsCodeApi call', () => {
    expect(fixDetailsScript).to.include('acquireVsCodeApi');
  });

  it('contains window message event listener', () => {
    expect(fixDetailsScript).to.include("window.addEventListener('message'");
  });

  it('contains IIFE wrapper for isolation', () => {
    expect(fixDetailsScript).to.include('(function () {');
  });

  it('contains task panel state management', () => {
    expect(fixDetailsScript).to.include('sessionActive');
    expect(fixDetailsScript).to.include("phase: 'waiting'");
    expect(fixDetailsScript).to.include('updateCurrentAction');
    expect(fixDetailsScript).to.include('currentOutcome');
  });

  it('contains automatic scrolling', () => {
    expect(fixDetailsScript).to.include('scrollToBottom');
  });

  it('contains console log function', () => {
    expect(fixDetailsScript).to.include('console.log');
  });

  it('contains inactivity timeout', () => {
    expect(fixDetailsScript).to.include('setTimeout');
    expect(fixDetailsScript).to.include('OpenCode 暂无响应');
  });

  it('contains hasReceivedContent flag', () => {
    expect(fixDetailsScript).to.include('hasReceivedContent');
  });

  it('contains task-panel specific state', () => {
    expect(fixDetailsScript).to.include('sessionStartedAt');
    expect(fixDetailsScript).to.include('changes');
    expect(fixDetailsScript).to.include('explanation');
    expect(fixDetailsScript).to.include('activeRunId');
    expect(fixDetailsScript).to.include('terminalLocked');
    expect(fixDetailsScript).to.include('collapsedCards');
  });

  it('contains multi-file diff rendering markers', () => {
    expect(fixDetailsScript).to.include('files-list');
    expect(fixDetailsScript).to.include('file-item');
    expect(fixDetailsScript).to.include('file-diff');
    expect(fixDetailsScript).to.include('line-add');
    expect(fixDetailsScript).to.include('line-del');
  });

  it('contains explanation accumulation from text_stream', () => {
    expect(fixDetailsScript).to.include('state.explanation');
    expect(fixDetailsScript).to.include('state.finalExplanation');
    expect(fixDetailsScript).to.include('state.finalExplanationKind');
    expect(fixDetailsScript).to.include('state.explanationMessages.set(messageId');
    expect(fixDetailsScript).to.include('getExplanationText()');
    expect(fixDetailsScript).to.include('isProgressMessageId(messageId)');
  });

  it('renders final-only explanation sections and full session ids', () => {
    expect(fixDetailsScript).to.include('Problem Explanation');
    expect(fixDetailsScript).to.include('Fix Explanation');
    expect(fixDetailsScript).to.include('Why it works');
    expect(fixDetailsScript).to.include('OpenCode Explanation');
    expect(fixDetailsScript).to.include('Explanation unavailable');
    expect(fixDetailsScript).to.include('Full Explanation');
    expect(fixDetailsScript).to.include('Failure Reason');
    expect(fixDetailsScript).to.include("if (!finished) {");
    expect(fixDetailsScript).to.include("els.metaSession.textContent = sid || '-'");
  });

  it('guards completed runs from stale running updates', () => {
    expect(fixDetailsScript).to.include('message.runId');
    expect(fixDetailsScript).to.include("message.type === 'session_end'");
    expect(fixDetailsScript).to.include("message.type === 'step_update' || message.type === 'tool_call' || message.type === 'tool_result'");
    expect(fixDetailsScript).to.include("guardedPhase === 'running' || guardedPhase === 'connecting' || guardedPhase === 'finalizing'");
  });

  it('toggles status-progress shimmer based on in-flight phase', () => {
    expect(fixDetailsScript).to.include('statusProgress');
    expect(fixDetailsScript).to.include("'status-progress'");
  });

  it('emits two-tone path/name spans for modified files', () => {
    expect(fixDetailsScript).to.include('file-path');
    expect(fixDetailsScript).to.include('file-name');
  });

  it('supports double-click collapse on primary cards', () => {
    expect(fixDetailsScript).to.include('dblclick');
    expect(fixDetailsScript).to.include('data-card-toggle');
    expect(fixDetailsScript).to.include('shouldIgnoreCollapseToggle');
    expect(fixDetailsScript).to.include('is-collapsed');
    expect(fixDetailsScript).to.include('status: false');
    expect(fixDetailsScript).to.include('files: false');
    expect(fixDetailsScript).to.include('explanation: false');
  });
});
