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

  it('contains all DOM element IDs', () => {
    const ids = [
      'messages',
      'waiting-indicator',
      'message-container',
      'session-target',
      'session-subtitle',
      'meta-model',
      'meta-session',
      'current-step-title',
      'current-step-detail',
      'result-panel',
      'result-title',
      'result-message',
      'result-summary',
      'result-diff-preview',
      'stopBtn',
      'cancelBtn',
      'queue-badge',
      'technical-details',
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

  it('contains message count tracking', () => {
    expect(fixDetailsScript).to.include('messageNodes');
  });

  it('contains hasReceivedContent flag', () => {
    expect(fixDetailsScript).to.include('hasReceivedContent');
  });

  it('contains task-panel specific state', () => {
    expect(fixDetailsScript).to.include('currentStepTitle');
    expect(fixDetailsScript).to.include('sessionStartedAt');
    expect(fixDetailsScript).to.include('changes');
    expect(fixDetailsScript).to.include('resultDiffPreview');
  });
});
