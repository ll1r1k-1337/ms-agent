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
    expect(fixDetailsScript).to.include('renderTasksCard');
    expect(fixDetailsScript).to.include('renderIdleHint');
    expect(fixDetailsScript).to.include('renderInlineMarkdown');
    expect(fixDetailsScript).to.include('formatDiffLines');
    expect(fixDetailsScript).to.include('renderCollapsedCards');
    expect(fixDetailsScript).to.include('toggleCardCollapse');
  });

  it('contains all DOM element IDs', () => {
    const ids = [
      'messages',
      'meta-model',
      'meta-backend',
      'meta-mode',
      'meta-elapsed',
      'status-card',
      'status-progress',
      'elapsed-row',
      'queue-row',
      'queue-badge',
      'idle-hint',
      'tasks-cancelled-group',
      'tasks-cancelled-list',
      'tasks-pause-btn',
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
      'task_detail',
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
    expect(fixDetailsScript).to.include("phase: 'connecting'");
    expect(fixDetailsScript).to.include('updateCurrentAction');
    expect(fixDetailsScript).to.include('currentAction');
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
    expect(fixDetailsScript).to.include('state.tasks');
    expect(fixDetailsScript).to.include('getOrCreateTaskRuntime');
    expect(fixDetailsScript).to.include('collapsedCards');
  });

  it('contains task diff rendering markers', () => {
    expect(fixDetailsScript).to.include('task-diff');
    expect(fixDetailsScript).to.include('file-diff');
    expect(fixDetailsScript).to.include('line-add');
    expect(fixDetailsScript).to.include('line-del');
  });

  it('accumulates streaming text into per-task runtime', () => {
    expect(fixDetailsScript).to.include('getOrCreateTaskRuntime');
    expect(fixDetailsScript).to.include('rt.streamText += delta');
    expect(fixDetailsScript).to.include('isProgressMessageId(messageId)');
    expect(fixDetailsScript).to.include('state.tasks');
  });

  it('guards completed tasks from stale running updates per task', () => {
    expect(fixDetailsScript).to.include('rt.outcome');
    expect(fixDetailsScript).to.include("phase === 'running' || phase === 'connecting' || phase === 'finalizing'");
    expect(fixDetailsScript).to.include('getOrCreateTaskRuntime');
  });

  it('toggles status-progress shimmer based on in-flight phase', () => {
    expect(fixDetailsScript).to.include('statusProgress');
    expect(fixDetailsScript).to.include("'status-progress'");
  });

  it('emits two-tone path/name spans for task diffs', () => {
    expect(fixDetailsScript).to.include('file-path');
    expect(fixDetailsScript).to.include('file-name');
  });

  it('supports double-click collapse on primary cards', () => {
    expect(fixDetailsScript).to.include('dblclick');
    expect(fixDetailsScript).to.include('data-card-toggle');
    expect(fixDetailsScript).to.include('shouldIgnoreCollapseToggle');
    expect(fixDetailsScript).to.include('is-collapsed');
    expect(fixDetailsScript).to.include('status: false');
    expect(fixDetailsScript).to.include('tasks: false');
  });

  it('renders completed tasks as expandable detail entries', () => {
    expect(fixDetailsScript).to.include('handleTaskDetail');
    expect(fixDetailsScript).to.include('buildCompletedTaskItem');
    expect(fixDetailsScript).to.include('taskDetailHtml');
    expect(fixDetailsScript).to.include('taskDiffHtml');
    expect(fixDetailsScript).to.include('task-entry');
    expect(fixDetailsScript).to.include('task-entry-summary');
    expect(fixDetailsScript).to.include('task-entry-body');
    expect(fixDetailsScript).to.include('task-detail-label');
    expect(fixDetailsScript).to.include('task-diff');
  });

  it('tracks per-task detail state and preserved expansion', () => {
    expect(fixDetailsScript).to.include('state.taskDetails');
    expect(fixDetailsScript).to.include('state.expandedTasks');
    expect(fixDetailsScript).to.include('Failure reason');
    expect(fixDetailsScript).to.include('Applied change');
  });

  it('surfaces a failed count in the Tasks card meta', () => {
    expect(fixDetailsScript).to.include('tasks-meta-failed');
    expect(fixDetailsScript).to.include("t.status === 'failed'");
  });

  it('separates failed tasks into a dedicated Failed group', () => {
    expect(fixDetailsScript).to.include('tasks-failed-group');
    expect(fixDetailsScript).to.include('tasks-failed-list');
    expect(fixDetailsScript).to.include("t.status !== 'failed'");
  });

  it('separates cancelled tasks into a dedicated Cancelled group', () => {
    expect(fixDetailsScript).to.include('tasks-cancelled-group');
    expect(fixDetailsScript).to.include('tasks-cancelled-list');
    expect(fixDetailsScript).to.include("t.status === 'cancelled'");
  });

  it('renders a per-task Cancel button and a header Pause control', () => {
    expect(fixDetailsScript).to.include('buildRunningTaskItem');
    expect(fixDetailsScript).to.include('task-cancel-btn');
    expect(fixDetailsScript).to.include("type: 'cancel_task'");
    expect(fixDetailsScript).to.include('tasksPauseBtn');
    expect(fixDetailsScript).to.include("type: 'pause_toggle'");
  });

  it('renders a per-task Session line and a live action sub-row', () => {
    expect(fixDetailsScript).to.include('taskSessionLineHtml');
    expect(fixDetailsScript).to.include('task-session');
    expect(fixDetailsScript).to.include('task-row-action');
    expect(fixDetailsScript).to.include('buildRunningTaskItem');
    expect(fixDetailsScript).to.include('opencodeSessionId');
  });

  it('phase-locks the running spinner so a rebuilt entry does not snap to 0deg', () => {
    expect(fixDetailsScript).to.include('animationDelay');
  });

  it('supports collapsing the Completed and Failed task groups', () => {
    expect(fixDetailsScript).to.include('toggleGroupCollapse');
    expect(fixDetailsScript).to.include('renderCollapsedGroups');
    expect(fixDetailsScript).to.include('collapsedGroups');
    expect(fixDetailsScript).to.include('data-group-toggle');
  });
});

describe('fixDetailsScript delta protocol', () => {
    it('contains applyQueueState as the single full-sync entry point', () => {
        expect(fixDetailsScript).to.include('function applyQueueState');
    });
    it('contains applyQueueDelta as the incremental entry point', () => {
        expect(fixDetailsScript).to.include('function applyQueueDelta');
    });
    it('handles queue_delta in the message dispatcher', () => {
        expect(fixDetailsScript).to.include("'queue_delta'");
    });
    it('keeps per-group DOM maps keyed by taskId', () => {
        expect(fixDetailsScript).to.include('groupNodeMaps');
    });
    it('uses event delegation on the task lists', () => {
        expect(fixDetailsScript).to.include("matches('.task-cancel-btn'");
    });
    it('posts request_queue_state on unknown taskId in a delta', () => {
        expect(fixDetailsScript).to.include("type: 'request_queue_state'");
    });
});
