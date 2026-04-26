import {
    SessionContext,
    SessionEvent,
    SessionLifecycleState,
    TERMINAL_STATES,
} from './sessionEvents';

export interface StateChangeListener {
    (snapshot: SessionStateSnapshot): void;
}

export interface SessionStateSnapshot {
    state: SessionLifecycleState;
    previous: SessionLifecycleState | null;
    context: SessionContext;
    event: SessionEvent | null;
}

/**
 * Centralized session state machine. All transitions go through `dispatch`.
 * Illegal transitions return false and emit no listener call so callers can
 * see the rejection in tests / logs without crashing the session.
 */
export class SessionStateMachine {
    private currentState: SessionLifecycleState = 'idle';
    private previousState: SessionLifecycleState | null = null;
    private context: SessionContext = {};
    private listeners: StateChangeListener[] = [];

    state(): SessionLifecycleState {
        return this.currentState;
    }

    snapshot(): SessionStateSnapshot {
        return {
            state: this.currentState,
            previous: this.previousState,
            context: { ...this.context },
            event: null,
        };
    }

    subscribe(listener: StateChangeListener): () => void {
        this.listeners.push(listener);
        return () => {
            const idx = this.listeners.indexOf(listener);
            if (idx >= 0) {
                this.listeners.splice(idx, 1);
            }
        };
    }

    /**
     * Returns true if the event resulted in a transition (or self-loop), false
     * if it was illegal in the current state.
     */
    dispatch(event: SessionEvent): boolean {
        const next = this.compute(this.currentState, event);
        if (!next) {
            return false;
        }
        const { state, context } = next;

        if (state !== this.currentState) {
            this.previousState = this.currentState;
            this.currentState = state;
        }
        this.context = { ...this.context, ...context };

        this.emit(event);
        return true;
    }

    isTerminal(): boolean {
        return TERMINAL_STATES.has(this.currentState);
    }

    private emit(event: SessionEvent): void {
        const snap: SessionStateSnapshot = {
            state: this.currentState,
            previous: this.previousState,
            context: { ...this.context },
            event,
        };
        for (const listener of this.listeners.slice()) {
            try {
                listener(snap);
            } catch {
                // Listeners must never break dispatch.
            }
        }
    }

    private compute(
        state: SessionLifecycleState,
        event: SessionEvent,
    ): { state: SessionLifecycleState; context: Partial<SessionContext> } | null {
        switch (state) {
            case 'idle':
                if (event.kind === 'START') {
                    return { state: 'sending', context: { detail: event.detail } };
                }
                return null;

            case 'sending':
                switch (event.kind) {
                    case 'FIRST_MEANINGFUL_EVENT':
                    case 'TEXT_DELTA':
                        return { state: 'streaming', context: {} };
                    case 'TOOL_CALL':
                        return { state: 'awaiting_tool', context: {} };
                    case 'TERMINAL_EVENT':
                        return {
                            state: 'applying_patch',
                            context: { detail: `terminal:${event.reason}` },
                        };
                    case 'TRANSPORT_ERROR':
                    case 'PROTOCOL_ERROR':
                        return { state: 'error', context: { errorMessage: event.reason } };
                    case 'TIMEOUT_NO_EVENTS':
                        return {
                            state: 'error',
                            context: { errorMessage: `No events after ${event.afterMs}ms` },
                        };
                    case 'USER_CANCEL':
                        return { state: 'cancelled', context: {} };
                    case 'TRANSPORT_CLOSED':
                        return {
                            state: 'error',
                            context: {
                                errorMessage: 'Transport closed before any events were received',
                            },
                        };
                    default:
                        return null;
                }

            case 'streaming':
                switch (event.kind) {
                    case 'TEXT_DELTA':
                    case 'FIRST_MEANINGFUL_EVENT':
                        return { state: 'streaming', context: {} };
                    case 'TOOL_CALL':
                        return { state: 'awaiting_tool', context: {} };
                    case 'TERMINAL_EVENT':
                        return {
                            state: 'applying_patch',
                            context: { detail: `terminal:${event.reason}` },
                        };
                    case 'TRANSPORT_ERROR':
                    case 'PROTOCOL_ERROR':
                        return { state: 'error', context: { errorMessage: event.reason } };
                    case 'TIMEOUT_INACTIVE':
                        return {
                            state: 'error',
                            context: { errorMessage: `Inactive for ${event.afterMs}ms` },
                        };
                    case 'USER_CANCEL':
                        return { state: 'cancelled', context: {} };
                    case 'TRANSPORT_CLOSED':
                        return event.sawTerminal
                            ? { state: 'streaming', context: {} }
                            : {
                                  state: 'error',
                                  context: {
                                      errorMessage: 'Transport closed before terminal event',
                                  },
                              };
                    default:
                        return null;
                }

            case 'awaiting_tool':
                switch (event.kind) {
                    case 'TOOL_RESULT_SENT':
                        return { state: 'streaming', context: {} };
                    case 'TOOL_CALL':
                        return { state: 'awaiting_tool', context: {} };
                    case 'TEXT_DELTA':
                        return { state: 'streaming', context: {} };
                    case 'TERMINAL_EVENT':
                        return {
                            state: 'applying_patch',
                            context: { detail: `terminal:${event.reason}` },
                        };
                    case 'TRANSPORT_ERROR':
                    case 'PROTOCOL_ERROR':
                        return { state: 'error', context: { errorMessage: event.reason } };
                    case 'USER_CANCEL':
                        return { state: 'cancelled', context: {} };
                    case 'TIMEOUT_INACTIVE':
                        return {
                            state: 'error',
                            context: { errorMessage: `Inactive for ${event.afterMs}ms` },
                        };
                    case 'TRANSPORT_CLOSED':
                        return event.sawTerminal
                            ? { state: 'awaiting_tool', context: {} }
                            : {
                                  state: 'error',
                                  context: {
                                      errorMessage: 'Transport closed before terminal event',
                                  },
                              };
                    default:
                        return null;
                }

            case 'applying_patch':
                switch (event.kind) {
                    case 'PATCH_APPLIED':
                        return { state: 'completed', context: { result: event.result } };
                    case 'PATCH_REJECTED':
                        return { state: 'error', context: { errorMessage: event.reason } };
                    case 'WRITE_FAILED':
                        return { state: 'error', context: { errorMessage: event.reason } };
                    case 'USER_CANCEL':
                        return { state: 'cancelled', context: {} };
                    default:
                        return null;
                }

            case 'completed':
            case 'error':
            case 'cancelled':
                if (event.kind === 'ENTER_TERMINAL') {
                    return { state: 'cleanup', context: {} };
                }
                return null;

            case 'cleanup':
                if (event.kind === 'DISPOSED') {
                    return { state: 'idle', context: {} };
                }
                return null;
        }
    }
}
