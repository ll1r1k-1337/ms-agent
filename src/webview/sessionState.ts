import {
  WebviewMessage,
  SessionStartPayload,
  SessionMetadataPayload,
  BackendInfoPayload,
  StatusPayload,
  StepUpdatePayload,
  ToolCallPayload,
  ToolResultPayload,
  DiffPayload,
  FinalDiffPayload,
  SessionEndPayload,
  ErrorPayload,
  ClearPayload,
} from '../webview/messages';

export interface SessionState {
  backend: string;
  mode: string;
  model: string;
  opencodeSessionId: string;
  degraded: boolean;
  phase: string;
  phaseMessage: string;
  steps: TimelineStep[];
  diffCards: DiffCardState[];
  completed: boolean;
  success: boolean | undefined;
  outcome: 'applied' | 'no_change' | 'failed' | undefined;
  finalMessage: string;
  startedAt: number;
}

export interface TimelineStep {
  id: string;
  type: 'planning' | 'reading_files' | 'calling_tools' | 'editing' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'tool_call' | 'tool_result';
  title: string;
  detail?: string;
  status: 'pending' | 'running' | 'success' | 'error';
  timestamp: number;
}

export interface DiffCardState {
  id: string;
  path: string;
  oldText: string;
  newText: string;
  changeSummary: string;
}

export function createInitialState(): SessionState {
  return {
    backend: '',
    mode: '',
    model: '',
    opencodeSessionId: '',
    degraded: false,
    phase: 'idle',
    phaseMessage: '',
    steps: [],
    diffCards: [],
    completed: false,
    success: undefined,
    outcome: undefined,
    finalMessage: '',
    startedAt: 0,
  };
}

export function reduceSessionState(state: SessionState, message: WebviewMessage): SessionState {
  switch (message.type) {
    case 'session_start': {
      const payload = message.payload as SessionStartPayload;
      return {
        ...state,
        backend: payload.backend,
        mode: payload.mode ?? '',
        model: payload.model ?? state.model,
        opencodeSessionId: '',
        completed: false,
        success: undefined,
        outcome: undefined,
        startedAt: Date.now(),
      };
    }

    case 'session_metadata': {
      const payload = message.payload as SessionMetadataPayload;
      return {
        ...state,
        opencodeSessionId: payload.opencodeSessionId ?? state.opencodeSessionId,
      };
    }

    case 'backend_info': {
      const payload = message.payload as BackendInfoPayload;
      return {
        ...state,
        backend: payload.backend,
        mode: payload.mode,
        model: payload.model ?? state.model,
        degraded: false,
      };
    }

    case 'status': {
      const payload = message.payload as StatusPayload;
      return {
        ...state,
        phase: payload.phase,
        phaseMessage: payload.message ?? '',
      };
    }

    case 'step_update': {
      const payload = message.payload as StepUpdatePayload;
      const step: TimelineStep = {
        id: `${payload.step}-${Date.now()}`,
        type: phaseToTimelineType(payload.step),
        title: payload.step,
        detail: payload.detail,
        status: 'running',
        timestamp: Date.now(),
      };
      return {
        ...state,
        steps: [...state.steps, step],
      };
    }

    case 'tool_call': {
      const payload = message.payload as ToolCallPayload;
      const step: TimelineStep = {
        id: payload.toolCallId,
        type: 'tool_call',
        title: payload.name,
        detail: JSON.stringify(payload.params),
        status: 'running',
        timestamp: Date.now(),
      };
      return {
        ...state,
        steps: [...state.steps, step],
      };
    }

    case 'tool_result': {
      const payload = message.payload as ToolResultPayload;
      const updatedSteps = state.steps.map((s) => {
        if (s.id === payload.toolCallId) {
          return {
            ...s,
            status: payload.isError ? 'error' : 'success' as TimelineStep['status'],
          };
        }
        return s;
      });
      return {
        ...state,
        steps: updatedSteps,
      };
    }

    case 'diff': {
      const payload = message.payload as DiffPayload;
      const card: DiffCardState = {
        id: payload.toolCallId,
        path: payload.path,
        oldText: payload.oldText,
        newText: payload.newText,
        changeSummary: computeChangeSummary(payload.oldText, payload.newText),
      };
      return {
        ...state,
        diffCards: [...state.diffCards, card],
      };
    }

    case 'final_diff': {
      const payload = message.payload as FinalDiffPayload;
      const existingIndex = state.diffCards.findIndex((c) => c.path === payload.path);
      if (existingIndex >= 0) {
        const updatedCards = [...state.diffCards];
        updatedCards[existingIndex] = {
          ...updatedCards[existingIndex],
          oldText: payload.oldContent,
          newText: payload.newContent,
          changeSummary: computeChangeSummary(payload.oldContent, payload.newContent),
        };
        return {
          ...state,
          diffCards: updatedCards,
        };
      }
      const card: DiffCardState = {
        id: `final-${Date.now()}`,
        path: payload.path,
        oldText: payload.oldContent,
        newText: payload.newContent,
        changeSummary: computeChangeSummary(payload.oldContent, payload.newContent),
      };
      return {
        ...state,
        diffCards: [...state.diffCards, card],
      };
    }

    case 'session_end': {
      const payload = message.payload as SessionEndPayload;
      return {
        ...state,
        completed: true,
        success: payload.success,
        outcome: payload.outcome,
        finalMessage: payload.finalMessage,
      };
    }

    case 'error': {
      const payload = message.payload as ErrorPayload;
      const step: TimelineStep = {
        id: `error-${Date.now()}`,
        type: 'failed',
        title: 'Error',
        detail: payload.message,
        status: 'error',
        timestamp: Date.now(),
      };
      return {
        ...state,
        phase: 'error',
        steps: [...state.steps, step],
      };
    }

    case 'clear': {
      return createInitialState();
    }

    default:
      return state;
  }
}

export function formatDiffToLines(
  oldText: string,
  newText: string
): Array<{ type: 'context' | 'add' | 'remove'; text: string; oldNum?: number; newNum?: number }> {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  if (oldText === newText) {
    return oldLines.map((text, index) => ({
      type: 'context' as const,
      text,
      oldNum: index + 1,
      newNum: index + 1,
    }));
  }

  let firstDiff = -1;
  let lastDiff = -1;
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    if (oldLines[i] !== newLines[i]) {
      if (firstDiff === -1) {
        firstDiff = i;
      }
      lastDiff = i;
    }
  }

  if (firstDiff === -1) {
    return [];
  }

  const start = Math.max(0, firstDiff - 2);
  const end = Math.min(maxLen - 1, lastDiff + 2);

  const result: Array<{ type: 'context' | 'add' | 'remove'; text: string; oldNum?: number; newNum?: number }> = [];

  let oldNum = start + 1;
  let newNum = start + 1;

  for (let i = start; i <= end; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    const hasOld = i < oldLines.length;
    const hasNew = i < newLines.length;

    if (hasOld && hasNew && oldLine === newLine) {
      result.push({ type: 'context', text: oldLine, oldNum, newNum });
      oldNum++;
      newNum++;
    } else if (hasOld && hasNew && oldLine !== newLine) {
      result.push({ type: 'remove', text: oldLine, oldNum });
      oldNum++;
      result.push({ type: 'add', text: newLine, newNum });
      newNum++;
    } else if (hasOld && !hasNew) {
      result.push({ type: 'remove', text: oldLine, oldNum });
      oldNum++;
    } else if (!hasOld && hasNew) {
      result.push({ type: 'add', text: newLine, newNum });
      newNum++;
    }
  }

  return result;
}

export function computeChangeSummary(oldText: string, newText: string): string {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const maxLen = Math.max(oldLines.length, newLines.length);

  let additions = 0;
  let deletions = 0;

  for (let i = 0; i < maxLen; i++) {
    const hasOld = i < oldLines.length;
    const hasNew = i < newLines.length;

    if (hasOld && hasNew && oldLines[i] !== newLines[i]) {
      additions++;
      deletions++;
    } else if (!hasOld && hasNew) {
      additions++;
    } else if (hasOld && !hasNew) {
      deletions++;
    }
  }

  return `${additions} addition${additions === 1 ? '' : 's'}, ${deletions} deletion${deletions === 1 ? '' : 's'}`;
}

export function phaseToTimelineType(phase: string): TimelineStep['type'] {
  const known: TimelineStep['type'][] = [
    'planning',
    'reading_files',
    'calling_tools',
    'editing',
    'verifying',
    'completed',
    'failed',
    'cancelled',
    'tool_call',
    'tool_result',
  ];

  if (known.includes(phase as TimelineStep['type'])) {
    return phase as TimelineStep['type'];
  }

  return 'calling_tools';
}
