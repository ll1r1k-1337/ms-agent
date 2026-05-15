/**
 * msAgent: OpenCode Activity output channel.
 *
 * The main `msAgent` output channel is verbose and noisy — every state-machine
 * transition and SDK frame goes there, which is great for post-mortem debugging
 * but useless when the user is staring at a frozen UI and asking "what is
 * OpenCode actually doing right now?".
 *
 * This channel answers that question. It writes only high-signal lines:
 *   - run start / end banners (file, error type, model, outcome)
 *   - server readiness transitions
 *   - each tool call (name + abbreviated params) when it starts
 *   - each tool result (elapsed time + result size, success/error)
 *   - stall warnings when a tool is in-flight with no events
 *
 * Lines are timestamped in HH:MM:SS.mmm so the user can correlate them with
 * what they're seeing in the editor.
 */
import * as vscode from 'vscode';

const CHANNEL_NAME = 'msAgent: OpenCode Activity';
const GLOBAL_KEY = 'msAgentActivityChannel';

export interface ActivityChannel {
    appendLine(line: string): void;
    show(preserveFocus?: boolean): void;
    dispose(): void;
}

/** Console fallback used in tests / when running outside the extension host. */
function consoleFallbackChannel(): ActivityChannel {
    return {
        appendLine: (line: string) => console.log(`[ActivityChannel] ${line}`),
        show: () => {},
        dispose: () => {},
    };
}

let cached: ActivityChannel | undefined;

/**
 * Construct (or return) the activity channel. Extensions should call this
 * exactly once during activation and store the returned instance.
 *
 * Modules that don't have access to the extension context can use
 * `getActivityChannel()` instead, which looks up the cached/global channel and
 * falls back to a console-backed shim when the VS Code API is unavailable.
 */
export function createActivityChannel(): ActivityChannel {
    const real = vscode.window.createOutputChannel(CHANNEL_NAME);
    cached = real as unknown as ActivityChannel;
    (global as unknown as Record<string, unknown>)[GLOBAL_KEY] = cached;
    return cached;
}

export function getActivityChannel(): ActivityChannel {
    if (cached) {
        return cached;
    }
    const fromGlobal = (global as unknown as Record<string, unknown>)[GLOBAL_KEY];
    if (fromGlobal && typeof (fromGlobal as ActivityChannel).appendLine === 'function') {
        cached = fromGlobal as ActivityChannel;
        return cached;
    }
    return consoleFallbackChannel();
}

/** For tests: drop the cached reference. */
export function _resetActivityChannelForTests(): void {
    cached = undefined;
    delete (global as unknown as Record<string, unknown>)[GLOBAL_KEY];
}

/** For tests: install a fake channel and return a transcript collector. */
export function _installFakeActivityChannelForTests(): { lines: string[]; channel: ActivityChannel } {
    const lines: string[] = [];
    const fake: ActivityChannel = {
        appendLine: (line: string) => lines.push(line),
        show: () => {},
        dispose: () => {},
    };
    cached = fake;
    (global as unknown as Record<string, unknown>)[GLOBAL_KEY] = fake;
    return { lines, channel: fake };
}

// ---------- formatting helpers ----------

export function formatTimestamp(date: Date = new Date()): string {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const pad3 = (n: number) => String(n).padStart(3, '0');
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${pad3(date.getMilliseconds())}`;
}

export function formatElapsed(ms: number): string {
    if (ms < 0 || !Number.isFinite(ms)) {
        return 'unknown';
    }
    if (ms < 1000) {
        return `${ms}ms`;
    }
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) {
        const tenths = Math.floor((ms % 1000) / 100);
        return `${totalSeconds}.${tenths}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

export function abbreviateParams(params: unknown, maxChars = 120): string {
    if (params === null || params === undefined) {
        return '';
    }
    let json: string;
    try {
        json = JSON.stringify(params);
    } catch {
        return '[unserializable]';
    }
    if (json === undefined) {
        return '';
    }
    if (json.length <= maxChars) {
        return json;
    }
    return `${json.slice(0, maxChars - 3)}...`;
}

// ---------- typed event helpers ----------

/** Emit a single line to the activity channel, prefixed with a timestamp. */
export function logActivity(line: string, channel: ActivityChannel = getActivityChannel()): void {
    channel.appendLine(`[${formatTimestamp()}] ${line}`);
}

export interface RunStartInfo {
    file: string;
    line: number;
    errorType: string;
    model: string;
    timeoutMs: number;
}

export function logRunStart(info: RunStartInfo, channel: ActivityChannel = getActivityChannel()): void {
    channel.appendLine('');
    channel.appendLine('────────────────────────────────────────');
    logActivity(`▶ Fix started — ${info.file}:${info.line}`, channel);
    logActivity(`  error: ${info.errorType}`, channel);
    logActivity(`  model: ${info.model}`, channel);
    logActivity(`  timeout: ${formatElapsed(info.timeoutMs)}`, channel);
}

export function logServerStarting(port: number, channel: ActivityChannel = getActivityChannel()): void {
    logActivity(`Starting OpenCode server on port ${port}…`, channel);
}

export function logServerReady(port: number, channel: ActivityChannel = getActivityChannel()): void {
    logActivity(`OpenCode server ready on port ${port}`, channel);
}

export function logServerNotice(message: string, channel: ActivityChannel = getActivityChannel()): void {
    logActivity(`server: ${message}`, channel);
}

export function logSessionOpened(sessionId: string, model: string, channel: ActivityChannel = getActivityChannel()): void {
    logActivity(`Session opened (${sessionId}) — model ${model}`, channel);
}

export interface ToolCallInfo {
    name: string;
    params: unknown;
    toolCallId: string;
}

/**
 * Format a params object for inline display. Returns an empty string when
 * the params are absent or trivially empty (`{}`), so callers can decide
 * whether to render `tool(...)` or just `tool`.
 */
export function formatParamsSuffix(params: unknown): string {
    if (params === null || params === undefined) {
        return '';
    }
    const abbrev = abbreviateParams(params);
    if (!abbrev || abbrev === '{}' || abbrev === '[]') {
        return '';
    }
    return `(${abbrev})`;
}

export function logToolCall(info: ToolCallInfo, channel: ActivityChannel = getActivityChannel()): void {
    const suffix = formatParamsSuffix(info.params);
    logActivity(`▶ tool: ${info.name}${suffix} — running…`, channel);
}

export interface ToolResultInfo {
    name: string;
    toolCallId: string;
    isError: boolean;
    elapsedMs: number;
    resultChars: number;
    errorPreview?: string;
    /**
     * Latest known input arguments for this call. The `pending` ToolPart
     * frame often carries an empty input that fills in via subsequent
     * `message.part.updated` events; pass the accumulated value here so the
     * result line shows what the model actually invoked.
     */
    params?: unknown;
}

export function logToolResult(info: ToolResultInfo, channel: ActivityChannel = getActivityChannel()): void {
    const elapsed = formatElapsed(info.elapsedMs);
    const size = info.resultChars >= 0 ? `${info.resultChars} chars` : 'no result';
    const suffix = formatParamsSuffix(info.params);
    if (info.isError) {
        const preview = info.errorPreview ? ` — ${info.errorPreview.slice(0, 120)}` : '';
        logActivity(`✗ tool: ${info.name}${suffix} failed in ${elapsed} (${size})${preview}`, channel);
    } else {
        logActivity(`✓ tool: ${info.name}${suffix} returned in ${elapsed} (${size})`, channel);
    }
}

export interface StallInfo {
    sinceLastEventMs: number;
    inFlightToolName?: string;
    inFlightToolElapsedMs?: number;
    smState: string;
}

export function logStall(info: StallInfo, channel: ActivityChannel = getActivityChannel()): void {
    const silence = formatElapsed(info.sinceLastEventMs);
    if (info.inFlightToolName && info.inFlightToolElapsedMs !== undefined) {
        const toolElapsed = formatElapsed(info.inFlightToolElapsedMs);
        logActivity(
            `⏳ still waiting on tool '${info.inFlightToolName}' — ${toolElapsed} elapsed, no events for ${silence}`,
            channel,
        );
    } else {
        logActivity(`⏳ no events for ${silence} (state: ${info.smState})`, channel);
    }
}

export function logTextProgress(totalChars: number, channel: ActivityChannel = getActivityChannel()): void {
    logActivity(`… streaming response (${totalChars} chars so far)`, channel);
}

export interface RunEndInfo {
    outcome: 'applied' | 'no_change' | 'failed';
    finalMessage: string;
    fileChanged: boolean;
    toolCallCount: number;
    elapsedMs: number;
}

export function logRunEnd(info: RunEndInfo, channel: ActivityChannel = getActivityChannel()): void {
    const elapsed = formatElapsed(info.elapsedMs);
    const tools = `${info.toolCallCount} tool call${info.toolCallCount === 1 ? '' : 's'}`;
    const oneLineMessage = info.finalMessage.replace(/\s+/g, ' ').trim();
    const truncated = oneLineMessage.length > 200 ? `${oneLineMessage.slice(0, 197)}...` : oneLineMessage;
    let symbol: string;
    let label: string;
    switch (info.outcome) {
        case 'applied':
            symbol = '✓';
            label = info.fileChanged ? 'Fix applied' : 'Reported applied (no file change)';
            break;
        case 'no_change':
            symbol = '·';
            label = 'No fix needed';
            break;
        case 'failed':
        default:
            symbol = '✗';
            label = 'Fix failed';
            break;
    }
    logActivity(`${symbol} ${label} — ${tools} in ${elapsed}`, channel);
    if (truncated) {
        logActivity(`  ${truncated}`, channel);
    }
    channel.appendLine('────────────────────────────────────────');
}

export function logRunTimeout(
    timeoutMs: number,
    sinceLastEventMs: number,
    inFlightToolName: string | undefined,
    channel: ActivityChannel = getActivityChannel(),
): void {
    logActivity(`⏱ timed out after ${formatElapsed(timeoutMs)}`, channel);
    if (inFlightToolName) {
        logActivity(
            `  last activity: tool '${inFlightToolName}' was awaiting result for ${formatElapsed(sinceLastEventMs)}`,
            channel,
        );
    } else {
        logActivity(`  no events for ${formatElapsed(sinceLastEventMs)} before timeout`, channel);
    }
}

export function logCancelled(channel: ActivityChannel = getActivityChannel()): void {
    logActivity(`✗ cancelled by user`, channel);
}

export function logRetry(reason: string, channel: ActivityChannel = getActivityChannel()): void {
    const oneLine = reason.replace(/\s+/g, ' ').trim();
    const truncated = oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
    logActivity(`↻ retrying — ${truncated}`, channel);
}
