/**
 * msAgent: OpenCode Raw Events output channel.
 *
 * msAgent already has two channels:
 *   - `msAgent` — verbose, logs every state-machine transition and the *type*
 *     of each SDK frame, but not the frame payload.
 *   - `msAgent: OpenCode Activity` — a curated, human-readable summary (tool
 *     calls, stalls, outcomes).
 *
 * Neither shows what OpenCode actually puts on the wire. This channel does.
 * It dumps every SSE event the OpenCode turn runner pulls off the stream —
 * one line per event, verbatim as JSON — *before* any session-scoping filter
 * is applied. It is the channel to open when a fix appears frozen and you
 * need to answer "is OpenCode still sending anything, and what?": if grep is
 * wedged you will see its tool part go pending -> running and then nothing
 * but `server.heartbeat` keep-alives.
 *
 * Each line is:
 *   `[HH:MM:SS.mmm] [<runner-session>] <disposition> <type> :: <json>`
 *
 *   - runner-session: the session id this runner owns, or `starting` before
 *     the session is created.
 *   - disposition: `emit` (forwarded to the session layer), `skip` (belongs
 *     to a different session — runners share one OpenCode server, so each
 *     `/event` subscription sees every session's events), or `buffered`
 *     (arrived before this runner's session existed).
 *
 * Logging here is pure observability: it must never throw and never influence
 * protocol decisions (see the `opencode-protocol` skill — `server.heartbeat`
 * and other unknown event types must be tolerated, not rejected).
 */
import * as vscode from 'vscode';
import { formatTimestamp } from './activityChannel';

const CHANNEL_NAME = 'msAgent: OpenCode Raw Events';
const GLOBAL_KEY = 'msAgentRawEventChannel';

/**
 * Hard cap on a single event's serialized JSON. A tool result (a large file
 * read, a wide grep) can be hundreds of KB; without a cap one event could
 * produce a multi-megabyte Output line and stall the panel.
 */
const MAX_PAYLOAD_CHARS = 20000;

export interface RawEventChannel {
    appendLine(line: string): void;
    show(preserveFocus?: boolean): void;
    dispose(): void;
}

/** What the turn runner did with an event, from the raw channel's point of view. */
export type RawEventDisposition = 'emit' | 'skip' | 'buffered';

/** Console fallback used in tests / when running outside the extension host. */
function consoleFallbackChannel(): RawEventChannel {
    return {
        appendLine: (line: string) => console.log(`[RawEventChannel] ${line}`),
        show: () => {},
        dispose: () => {},
    };
}

let cached: RawEventChannel | undefined;

/**
 * Construct (or return) the raw-event channel. The extension should call this
 * exactly once during activation and store the returned instance.
 *
 * Modules without access to the extension context use `getRawEventChannel()`,
 * which looks up the cached/global channel and falls back to a console-backed
 * shim when the VS Code API is unavailable.
 */
export function createRawEventChannel(): RawEventChannel {
    const real = vscode.window.createOutputChannel(CHANNEL_NAME);
    cached = real as unknown as RawEventChannel;
    (global as unknown as Record<string, unknown>)[GLOBAL_KEY] = cached;
    return cached;
}

export function getRawEventChannel(): RawEventChannel {
    if (cached) {
        return cached;
    }
    const fromGlobal = (global as unknown as Record<string, unknown>)[GLOBAL_KEY];
    if (fromGlobal && typeof (fromGlobal as RawEventChannel).appendLine === 'function') {
        cached = fromGlobal as RawEventChannel;
        return cached;
    }
    return consoleFallbackChannel();
}

/** For tests: drop the cached reference. */
export function _resetRawEventChannelForTests(): void {
    cached = undefined;
    delete (global as unknown as Record<string, unknown>)[GLOBAL_KEY];
}

/** For tests: install a fake channel and return a transcript collector. */
export function _installFakeRawEventChannelForTests(): { lines: string[]; channel: RawEventChannel } {
    const lines: string[] = [];
    const fake: RawEventChannel = {
        appendLine: (line: string) => lines.push(line),
        show: () => {},
        dispose: () => {},
    };
    cached = fake;
    (global as unknown as Record<string, unknown>)[GLOBAL_KEY] = fake;
    return { lines, channel: fake };
}

// ---------- formatting helpers ----------

/**
 * Best-effort `type` discriminator of an OpenCode SSE envelope. Per the
 * `opencode-protocol` skill (R1) every wire frame is a flat `{type, properties}`
 * object, so the discriminator is the top-level `type`. Returns a parenthesized
 * marker for anything that is not a typed object so the column is never blank.
 */
export function rawEventType(event: unknown): string {
    if (event === null) {
        return '(null)';
    }
    if (event === undefined) {
        return '(undefined)';
    }
    if (typeof event !== 'object') {
        return `(${typeof event})`;
    }
    const type = (event as Record<string, unknown>).type;
    return typeof type === 'string' && type.length > 0 ? type : '(no-type)';
}

/**
 * Serialize an event to a single-line JSON string. Capped at `maxChars` and
 * guaranteed never to throw — a circular or otherwise unserializable event
 * yields a placeholder rather than crashing the run.
 */
export function stringifyRawEvent(event: unknown, maxChars = MAX_PAYLOAD_CHARS): string {
    let json: string | undefined;
    try {
        json = JSON.stringify(event);
    } catch {
        return '[unserializable event]';
    }
    if (json === undefined) {
        // JSON.stringify returns undefined for `undefined`, functions, symbols.
        return String(event);
    }
    if (json.length > maxChars) {
        return `${json.slice(0, maxChars)}… [truncated ${json.length - maxChars} chars]`;
    }
    return json;
}

export interface RawEventInfo {
    /** Session id this runner owns; undefined/null before the session exists. */
    runnerSessionId?: string | null;
    /** What the runner did with this event. */
    disposition: RawEventDisposition;
}

/** Append one verbatim event line to the raw-event channel. */
export function logRawEvent(
    event: unknown,
    info: RawEventInfo,
    channel: RawEventChannel = getRawEventChannel(),
): void {
    const scope = info.runnerSessionId || 'starting';
    channel.appendLine(
        `[${formatTimestamp()}] [${scope}] ${info.disposition} ${rawEventType(event)}`
        + ` :: ${stringifyRawEvent(event)}`,
    );
}
