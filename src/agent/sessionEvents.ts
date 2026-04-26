/**
 * Backend-side fix session lifecycle types. Distinct from src/webview/sessionState.ts,
 * which models webview UI state (phase / timeline / diff cards).
 */
export type SessionLifecycleState =
    | 'idle'
    | 'sending'
    | 'streaming'
    | 'awaiting_tool'
    | 'applying_patch'
    | 'completed'
    | 'error'
    | 'cancelled'
    | 'cleanup';

export const TERMINAL_STATES: ReadonlySet<SessionLifecycleState> = new Set([
    'completed',
    'error',
    'cancelled',
]);

export interface SessionResult {
    success: boolean;
    fileChanged: boolean;
    finalMessage: string;
    toolCallCount: number;
    originalContent?: string;
    newContent?: string;
}

export interface SessionContext {
    /** Optional human-readable detail attached to the current state. */
    detail?: string;
    /** Populated when state === 'error'. */
    errorMessage?: string;
    /** Populated on entry to 'completed' or 'error'. */
    result?: SessionResult;
}

export type SessionEvent =
    | { kind: 'START'; detail?: string }
    | { kind: 'FIRST_MEANINGFUL_EVENT' }
    | { kind: 'TEXT_DELTA'; chunk: string }
    | { kind: 'TOOL_CALL'; name: string; toolCallId: string }
    | { kind: 'TOOL_RESULT_SENT'; toolCallId: string }
    | { kind: 'TERMINAL_EVENT'; reason: 'done' | 'step_end' | 'message_completed' }
    | { kind: 'PATCH_APPLIED'; result: SessionResult }
    | { kind: 'PATCH_REJECTED'; reason: string }
    | { kind: 'WRITE_FAILED'; reason: string }
    | { kind: 'PROTOCOL_ERROR'; reason: string }
    | { kind: 'TRANSPORT_ERROR'; reason: string }
    | { kind: 'TRANSPORT_CLOSED'; sawTerminal: boolean }
    | { kind: 'TIMEOUT_NO_EVENTS'; afterMs: number }
    | { kind: 'TIMEOUT_INACTIVE'; afterMs: number }
    | { kind: 'USER_CANCEL' }
    | { kind: 'ENTER_TERMINAL' }
    | { kind: 'DISPOSED' };

export type SessionEventKind = SessionEvent['kind'];
