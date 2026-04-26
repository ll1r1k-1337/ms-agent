(function () {
    'use strict';

    let vscode;
    try {
        vscode = acquireVsCodeApi();
    } catch (error) {
        console.log('[msAgent WebView] Failed to acquire VS Code API: ' + error);
        return;
    }

    const PHASE_LABELS = {
        connecting: '连接中',
        running: '处理中',
        finalizing: '收尾中',
        error: '异常',
        waiting: '等待中',
        completed: '完成',
        no_change: '未修改',
        failed: '失败',
        idle: 'Idle',
    };

    const state = {
        sessionStartedAt: 0,
        sessionActive: false,
        hasReceivedContent: false,
        elapsedTimerId: null,
        inactivityTimeoutId: null,
        target: '准备开始下一次修复',
        phase: 'waiting',
        currentOutcome: 'pending',
        finalMessage: '',
        backend: '',
        mode: '',
        model: '',
        opencodeSessionId: '',
        queueState: { paused: false, hasPendingTasks: false, items: [] },
        steps: [],
        stepIndex: new Map(),
        changes: new Map(),
        explanation: '',
        messageNodes: new Map(),
    };

    const els = {};

    function $(id) { return document.getElementById(id); }

    function initElements() {
        els.messages = $('messages');
        els.statusPill = $('status-pill');
        els.statusLabel = $('status-label');
        els.sessionTarget = $('session-target');
        els.metaElapsed = $('meta-elapsed');
        els.queueBadge = $('queue-badge');
        els.stopBtn = $('stopBtn');
        els.cancelBtn = $('cancelBtn');
        els.sessionPhase = $('session-phase');
        els.metaBackend = $('meta-backend');
        els.metaMode = $('meta-mode');
        els.metaModel = $('meta-model');
        els.metaSession = $('meta-session');
        els.stepsCard = $('steps-card');
        els.stepsList = $('steps-list');
        els.stepsMeta = $('steps-meta');
        els.filesCard = $('files-card');
        els.filesList = $('files-list');
        els.filesMeta = $('files-meta');
        els.explanationCard = $('explanation-card');
        els.explanationBody = $('explanation-body');
        els.explanationMeta = $('explanation-meta');
        els.waitingIndicator = $('waiting-indicator');
        els.technicalDetails = $('technical-details');
        els.messageContainer = $('message-container');
    }

    function log(message) {
        console.log('[msAgent WebView] ' + message);
    }

    // ── helpers ──────────────────────────────────────────────────

    function escapeHtml(value) {
        if (value === undefined || value === null) {
            return '';
        }
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function basename(filePath) {
        if (!filePath) {
            return '';
        }
        const normalized = String(filePath).replace(/\\/g, '/');
        const parts = normalized.split('/');
        return parts[parts.length - 1] || normalized;
    }

    function dirname(filePath) {
        if (!filePath) {
            return '';
        }
        const normalized = String(filePath).replace(/\\/g, '/');
        const idx = normalized.lastIndexOf('/');
        return idx >= 0 ? normalized.slice(0, idx + 1) : '';
    }

    function formatDuration(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }

    function firstString(object, keys) {
        if (!object || typeof object !== 'object') {
            return '';
        }
        for (let i = 0; i < keys.length; i += 1) {
            const value = object[keys[i]];
            if (typeof value === 'string' && value.trim()) {
                return value;
            }
        }
        return '';
    }

    function summarizeToolCall(name, params) {
        const pathValue = firstString(params, ['path', 'filePath', 'uri', 'command']);
        if (pathValue) {
            return name.replace(/_/g, ' ') + ' · ' + basename(pathValue);
        }
        return name.replace(/_/g, ' ');
    }

    function summarizeToolResult(result, isError) {
        const normalized = String(result || '').trim().replace(/\s+/g, ' ');
        if (!normalized) {
            return isError ? '工具返回错误。' : '工具执行完成。';
        }
        return normalized.length > 140 ? normalized.slice(0, 137) + '...' : normalized;
    }

    function diffStat(oldText, newText) {
        const oldLines = String(oldText || '').split('\n');
        const newLines = String(newText || '').split('\n');
        let added = 0;
        let removed = 0;
        const maxLen = Math.max(oldLines.length, newLines.length);
        for (let i = 0; i < maxLen; i += 1) {
            const oldLine = oldLines[i];
            const newLine = newLines[i];
            const hasOld = i < oldLines.length;
            const hasNew = i < newLines.length;
            if (hasOld && hasNew && oldLine === newLine) {
                continue;
            }
            if (hasOld) {
                removed += 1;
            }
            if (hasNew) {
                added += 1;
            }
        }
        return { added: added, removed: removed };
    }

    function formatSimpleDiff(oldText, newText) {
        const lines = formatDiffLines(oldText, newText);
        return lines.map(function (l) { return l.text; }).slice(0, 18).join('\n');
    }

    function formatDiffLines(oldText, newText) {
        if (!oldText && !newText) {
            return [{ type: 'meta', text: '(no changes)' }];
        }
        const oldLines = String(oldText || '').split('\n');
        const newLines = String(newText || '').split('\n');
        const out = [];
        const maxLen = Math.max(oldLines.length, newLines.length);

        let firstDiff = -1;
        let lastDiff = -1;
        for (let i = 0; i < maxLen; i += 1) {
            if ((oldLines[i] || '') !== (newLines[i] || '')) {
                if (firstDiff < 0) {
                    firstDiff = i;
                }
                lastDiff = i;
            }
        }
        if (firstDiff < 0) {
            return [{ type: 'meta', text: '(no textual changes)' }];
        }

        const start = Math.max(0, firstDiff - 2);
        const end = Math.min(maxLen - 1, lastDiff + 2);

        if (start > 0) {
            out.push({ type: 'meta', text: '@@ skipped ' + start + ' lines @@' });
        }
        for (let i = start; i <= end; i += 1) {
            const oldLine = oldLines[i];
            const newLine = newLines[i];
            const hasOld = i < oldLines.length;
            const hasNew = i < newLines.length;
            if (hasOld && hasNew && oldLine === newLine) {
                out.push({ type: 'ctx', text: '  ' + oldLine });
            } else {
                if (hasOld) {
                    out.push({ type: 'del', text: '- ' + oldLine });
                }
                if (hasNew) {
                    out.push({ type: 'add', text: '+ ' + newLine });
                }
            }
        }
        if (end < maxLen - 1) {
            out.push({ type: 'meta', text: '@@ skipped ' + (maxLen - 1 - end) + ' lines @@' });
        }
        return out;
    }

    function renderInlineMarkdown(text) {
        const escaped = escapeHtml(text);
        const placeholders = [];
        let html = escaped.replace(/```([a-zA-Z0-9_+\-]*)\r?\n([\s\S]*?)```/g, function (_m, _lang, body) {
            const idx = placeholders.length;
            placeholders.push('<pre>' + body.replace(/\n$/, '') + '</pre>');
            return ' PRE' + idx + ' ';
        });
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        const blocks = html.split(/\n{2,}/).map(function (block) {
            const trimmed = block.trim();
            if (!trimmed) {
                return '';
            }
            return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
        });
        let combined = blocks.join('');
        combined = combined.replace(/<p> PRE(\d+) <\/p>/g, function (_m, i) {
            return placeholders[Number(i)];
        });
        combined = combined.replace(/ PRE(\d+) /g, function (_m, i) {
            return placeholders[Number(i)];
        });
        return combined;
    }

    function scrollToBottom() {
        if (!els.messages) {
            return;
        }
        els.messages.scrollTop = els.messages.scrollHeight;
    }

    // ── timers ───────────────────────────────────────────────────

    function clearInactivityTimeout() {
        if (state.inactivityTimeoutId) {
            clearTimeout(state.inactivityTimeoutId);
            state.inactivityTimeoutId = null;
        }
    }

    function scheduleInactivityTimeout() {
        clearInactivityTimeout();
        state.inactivityTimeoutId = setTimeout(function () {
            if (!state.hasReceivedContent) {
                state.target = 'OpenCode 暂无响应';
                state.explanation = '后端可能仍在启动，或连接还没有建立。可以查看 msAgent 输出面板确认详细日志。';
                renderAll();
            }
        }, 15000);
    }

    function startElapsedTimer() {
        stopElapsedTimer();
        state.elapsedTimerId = setInterval(updateElapsed, 1000);
        updateElapsed();
    }

    function stopElapsedTimer() {
        if (state.elapsedTimerId) {
            clearInterval(state.elapsedTimerId);
            state.elapsedTimerId = null;
        }
    }

    function updateElapsed() {
        const elapsed = state.sessionStartedAt > 0 ? Math.max(0, Date.now() - state.sessionStartedAt) : 0;
        if (els.metaElapsed) {
            els.metaElapsed.textContent = formatDuration(elapsed);
        }
    }

    // ── render ──────────────────────────────────────────────────

    function phaseToPillKind() {
        if (state.currentOutcome === 'applied') return 'success';
        if (state.currentOutcome === 'failed' || state.phase === 'error') return 'error';
        if (state.currentOutcome === 'no_change') return 'warning';
        if (state.phase === 'running' || state.phase === 'connecting' || state.phase === 'finalizing') {
            return 'running';
        }
        return 'waiting';
    }

    function renderStrip() {
        if (els.sessionTarget) {
            els.sessionTarget.textContent = state.target;
            els.sessionTarget.title = state.target;
        }
        if (els.statusPill && els.statusLabel) {
            els.statusPill.className = 'status-pill is-' + phaseToPillKind();
            els.statusLabel.textContent = PHASE_LABELS[state.phase] || PHASE_LABELS.waiting;
        }
        if (els.queueBadge) {
            const queued = state.queueState.items.length;
            els.queueBadge.textContent = '队列 ' + queued;
            els.queueBadge.classList.toggle('hidden', queued === 0);
        }
        if (els.stopBtn) {
            els.stopBtn.classList.toggle('hidden', !state.queueState.hasPendingTasks);
            els.stopBtn.textContent = state.queueState.paused ? 'Resume' : 'Pause';
        }
        if (els.cancelBtn) {
            els.cancelBtn.classList.toggle('hidden', !state.queueState.hasPendingTasks);
        }
    }

    function renderStatusCard() {
        if (els.sessionPhase) {
            els.sessionPhase.textContent = PHASE_LABELS[state.phase] || PHASE_LABELS.waiting;
        }
        if (els.metaBackend) els.metaBackend.textContent = state.backend || '-';
        if (els.metaMode) els.metaMode.textContent = state.mode || '-';
        if (els.metaModel) els.metaModel.textContent = state.model || '-';
        if (els.metaSession) {
            const sid = state.opencodeSessionId || '';
            const display = sid.length > 20 ? sid.slice(0, 8) + '…' + sid.slice(-8) : (sid || '-');
            els.metaSession.textContent = display;
            els.metaSession.title = sid;
        }
    }

    function stepIconHtml(step) {
        if (step.status === 'success') return '<span>✓</span>';
        if (step.status === 'error') return '<span>✕</span>';
        if (step.status === 'running') {
            return '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" class="spin">'
                + '<circle cx="12" cy="12" r="9" stroke-opacity="0.25"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>';
        }
        return '<span>·</span>';
    }

    function stepClass(step) {
        if (step.status === 'success') return 'is-done';
        if (step.status === 'error') return 'is-error';
        if (step.status === 'running') return 'is-active';
        return 'is-pending';
    }

    function renderSteps() {
        if (!els.stepsCard || !els.stepsList || !els.stepsMeta) return;
        if (state.steps.length === 0) {
            els.stepsCard.classList.add('hidden');
            return;
        }
        els.stepsCard.classList.remove('hidden');
        const done = state.steps.filter(function (s) {
            return s.status === 'success' || s.status === 'error';
        }).length;
        els.stepsMeta.textContent = done + ' / ' + state.steps.length;
        const html = state.steps.map(function (step) {
            return '<li class="step-item ' + stepClass(step) + '">'
                + '<span class="step-icon">' + stepIconHtml(step) + '</span>'
                + '<span class="step-label">' + escapeHtml(step.label) + '</span>'
                + '</li>';
        }).join('');
        els.stepsList.innerHTML = html;
    }

    function renderFiles() {
        if (!els.filesCard || !els.filesList || !els.filesMeta) return;
        const files = Array.from(state.changes.values());
        if (files.length === 0) {
            els.filesCard.classList.add('hidden');
            return;
        }
        els.filesCard.classList.remove('hidden');
        els.filesMeta.textContent = files.length + ' file' + (files.length === 1 ? '' : 's');
        const html = files.map(fileHtml).join('');
        els.filesList.innerHTML = html;
    }

    function fileHtml(file) {
        const stat = diffStat(file.oldText, file.newText);
        const lines = formatDiffLines(file.oldText, file.newText);
        const diffHtml = lines.map(function (l) {
            const cls = l.type === 'add' ? 'line-add'
                : l.type === 'del' ? 'line-del'
                : l.type === 'ctx' ? 'line-ctx'
                : 'line-meta';
            return '<span class="' + cls + '">' + escapeHtml(l.text) + '</span>';
        }).join('');
        return '<details class="file-item" open>'
            + '<summary class="file-summary">'
                + '<span class="file-path">' + escapeHtml(dirname(file.path)) + '</span>'
                + '<span class="file-name">' + escapeHtml(basename(file.path)) + '</span>'
                + '<span class="file-stat"><span class="add">+' + stat.added + '</span> '
                    + '<span class="del">-' + stat.removed + '</span></span>'
            + '</summary>'
            + '<pre class="file-diff">' + diffHtml + '</pre>'
            + '</details>';
    }

    function renderExplanation() {
        if (!els.explanationCard || !els.explanationBody || !els.explanationMeta) return;
        const text = state.explanation.trim();
        const finished = state.currentOutcome !== 'pending';
        if (!text && !finished) {
            els.explanationCard.classList.add('hidden');
            return;
        }
        els.explanationCard.classList.remove('hidden');
        if (text) {
            els.explanationBody.classList.remove('is-empty');
            els.explanationBody.innerHTML = renderInlineMarkdown(text);
            els.explanationMeta.textContent = finished ? '已完成' : 'Streaming…';
        } else {
            els.explanationBody.classList.add('is-empty');
            els.explanationBody.textContent =
                'OpenCode 未给出自然语言解释，可在 Steps / Modified Files 卡片中查看具体动作。';
            els.explanationMeta.textContent = '空';
        }
    }

    function renderEmptyState() {
        if (!els.waitingIndicator) return;
        const hasContent = state.sessionActive
            || state.steps.length > 0
            || state.changes.size > 0
            || state.explanation
            || state.currentOutcome !== 'pending'
            || state.hasReceivedContent;
        els.waitingIndicator.classList.toggle('hidden', hasContent);
    }

    function renderAll() {
        renderStrip();
        renderStatusCard();
        renderSteps();
        renderFiles();
        renderExplanation();
        renderEmptyState();
    }

    // ── raw technical log ────────────────────────────────────────

    function appendTechnicalEntry(id, kind, title, body, status) {
        if (!els.messageContainer) {
            return null;
        }
        let node = state.messageNodes.get(id);
        if (!node) {
            node = document.createElement('div');
            node.className = 'tech-entry';
            node.innerHTML =
                '<div class="tech-entry-head">'
                    + '<span class="tech-entry-title"></span>'
                    + '<span class="tech-entry-kind"></span>'
                + '</div>'
                + '<div class="tech-entry-body"></div>';
            state.messageNodes.set(id, node);
            els.messageContainer.appendChild(node);
        }
        node.className = 'tech-entry' + (status ? ' is-' + status : '');
        node.querySelector('.tech-entry-title').textContent = title;
        node.querySelector('.tech-entry-kind').textContent = kind;
        node.querySelector('.tech-entry-body').textContent = body;
        scrollToBottom();
        return node;
    }

    // ── handlers ─────────────────────────────────────────────────

    function appendTextStream(messageId, delta) {
        if (!delta) return;
        state.hasReceivedContent = true;
        state.explanation += delta;
        clearInactivityTimeout();
        appendTechnicalEntry(
            'text:' + messageId,
            'assistant',
            'Assistant',
            state.explanation,
            ''
        );
        renderExplanation();
        renderEmptyState();
    }

    function appendUserMessage(messageId, text) {
        if (text) {
            state.target = text;
        }
        appendTechnicalEntry('user:' + messageId, 'request', 'Fix Request', text || '', '');
        renderStrip();
        renderEmptyState();
    }

    function updateCurrentAction(label) {
        // Surface a lightweight progress marker as a transient running step.
        // Kept as a named function so future extension/tests can target it.
        if (!label) return;
        const id = 'action:' + Date.now() + ':' + Math.random().toString(36).slice(2, 6);
        const step = { id: id, name: 'action', label: label, status: 'running' };
        state.stepIndex.set(id, step);
        state.steps.push(step);
        renderSteps();
    }

    function appendToolCall(messageId, toolCallId, name, params) {
        const id = toolCallId || messageId || ('tool:' + Date.now());
        const label = summarizeToolCall(name, params);
        const step = { id: id, name: name, label: label, status: 'running' };
        if (state.stepIndex.has(id)) {
            const existing = state.stepIndex.get(id);
            existing.label = label;
            existing.status = 'running';
        } else {
            state.stepIndex.set(id, step);
            state.steps.push(step);
        }
        const detail = JSON.stringify(params || {}, null, 2);
        appendTechnicalEntry(id, 'tool', label, detail, '');
        state.phase = 'running';
        state.hasReceivedContent = true;
        clearInactivityTimeout();
        renderStrip();
        renderStatusCard();
        renderSteps();
        renderEmptyState();
    }

    function appendToolResult(toolCallId, result, isError) {
        const step = state.stepIndex.get(toolCallId);
        if (step) {
            step.status = isError ? 'error' : 'success';
        }
        appendTechnicalEntry(
            toolCallId,
            'tool',
            step ? step.label : 'Tool Result',
            String(result || '') || summarizeToolResult(result, isError),
            isError ? 'error' : 'success'
        );
        if (isError) {
            state.phase = 'error';
        }
        renderStrip();
        renderStatusCard();
        renderSteps();
    }

    function appendDiff(payload, isFinal) {
        if (!payload || !payload.path) return;
        const oldText = isFinal ? payload.oldContent : payload.oldText;
        const newText = isFinal ? payload.newContent : payload.newText;
        state.changes.set(payload.path, {
            path: payload.path,
            oldText: oldText || '',
            newText: newText || '',
        });
        if (isFinal && payload.message && !state.explanation.trim()) {
            state.explanation = payload.message;
        }
        const id = (isFinal ? 'final:' : 'diff:') + payload.path;
        const title = (isFinal ? 'Final Diff · ' : 'Diff · ') + basename(payload.path);
        appendTechnicalEntry(id, 'diff', title, formatSimpleDiff(oldText, newText), 'success');
        state.hasReceivedContent = true;
        renderFiles();
        renderExplanation();
        renderEmptyState();
    }

    function appendFinalDiff(payload) {
        appendDiff(payload, true);
    }

    function completeMessage(_messageId) {
        scrollToBottom();
    }

    function updateStatus(phase, message) {
        if (phase) {
            state.phase = phase;
        }
        if (message) {
            updateCurrentAction(message);
        }
        renderStrip();
        renderStatusCard();
        renderEmptyState();
    }

    function updateQueueState(payload) {
        state.queueState = payload || state.queueState;
        renderStrip();
    }

    function handleSessionStart(payload) {
        state.sessionStartedAt = Date.now();
        state.sessionActive = true;
        state.hasReceivedContent = false;
        state.steps = [];
        state.stepIndex = new Map();
        state.changes = new Map();
        state.explanation = '';
        state.currentOutcome = 'pending';
        state.finalMessage = '';
        state.phase = 'connecting';
        state.opencodeSessionId = '';
        state.backend = (payload && payload.backend) || state.backend;
        state.mode = (payload && payload.mode) || state.mode;
        state.model = (payload && payload.model) || state.model;
        renderAll();
        startElapsedTimer();
        scheduleInactivityTimeout();
    }

    function appendSessionResult(outcome, finalMessage) {
        const normalized = outcome || 'failed';
        state.sessionActive = false;
        state.currentOutcome = normalized;
        state.finalMessage = finalMessage || '';
        if (normalized === 'applied') {
            state.phase = 'completed';
        } else if (normalized === 'no_change') {
            state.phase = 'no_change';
        } else {
            state.phase = 'failed';
        }
        if (finalMessage && !state.explanation.trim()) {
            state.explanation = finalMessage;
        }
        clearInactivityTimeout();
        stopElapsedTimer();
        renderAll();
    }

    function clearAll() {
        clearInactivityTimeout();
        stopElapsedTimer();
        state.sessionStartedAt = 0;
        state.sessionActive = false;
        state.hasReceivedContent = false;
        state.target = '准备开始下一次修复';
        state.phase = 'waiting';
        state.currentOutcome = 'pending';
        state.finalMessage = '';
        state.backend = '';
        state.mode = '';
        state.model = '';
        state.opencodeSessionId = '';
        state.steps = [];
        state.stepIndex = new Map();
        state.changes = new Map();
        state.explanation = '';
        state.messageNodes = new Map();
        if (els.messageContainer) {
            els.messageContainer.innerHTML = '';
        }
        if (els.metaElapsed) {
            els.metaElapsed.textContent = '00:00';
        }
        renderAll();
    }

    function handleMessage(message) {
        if (!message || !message.type) {
            return;
        }
        log('handleMessage ' + message.type);
        const p = message.payload || {};
        switch (message.type) {
            case 'session_start':
                handleSessionStart(p);
                break;
            case 'session_metadata':
                state.opencodeSessionId = p.opencodeSessionId || state.opencodeSessionId;
                renderStatusCard();
                break;
            case 'session_end':
                appendSessionResult(p.outcome, p.finalMessage);
                break;
            case 'status':
                updateStatus(p.phase, p.message);
                break;
            case 'backend_info':
                state.backend = p.backend || state.backend;
                state.mode = p.mode || state.mode;
                state.model = p.model || state.model;
                renderStatusCard();
                break;
            case 'step_update':
                updateStatus('running', p.detail ? p.step + ' · ' + p.detail : p.step);
                break;
            case 'tool_call':
                appendToolCall(p.messageId, p.toolCallId, p.name, p.params);
                break;
            case 'tool_result':
                appendToolResult(p.toolCallId, p.result, !!p.isError);
                break;
            case 'diff':
                appendDiff(p, false);
                break;
            case 'final_diff':
                appendFinalDiff(p);
                break;
            case 'text_stream':
                appendTextStream(p.messageId, p.delta || '');
                break;
            case 'user_message':
                appendUserMessage(p.messageId, p.text || '');
                break;
            case 'message_complete':
                completeMessage(p.messageId);
                break;
            case 'error':
                appendSessionResult('failed', p.message || 'Unknown error');
                appendTechnicalEntry('error:' + Date.now(), 'error', 'Error', p.message || 'Unknown error', 'error');
                break;
            case 'clear':
                clearAll();
                break;
            case 'queue_state':
                updateQueueState(p);
                break;
            default:
                break;
        }
    }

    function bindEvents() {
        if (els.stopBtn) {
            els.stopBtn.addEventListener('click', function () {
                vscode.postMessage({ type: 'pause_toggle' });
            });
        }
        if (els.cancelBtn) {
            els.cancelBtn.addEventListener('click', function () {
                vscode.postMessage({ type: 'cancel_current' });
            });
        }
        window.addEventListener('message', function (event) {
            handleMessage(event.data);
        });
    }

    function renderResult() {
        // Backward-compatible alias: result rendering is split across
        // renderFiles + renderExplanation. Kept as an entry point for tests.
        renderFiles();
        renderExplanation();
    }

    function initialize() {
        initElements();
        bindEvents();
        renderAll();
        renderResult();
        vscode.postMessage({ type: 'fix_details_ready' });
    }

    initialize();
}());
