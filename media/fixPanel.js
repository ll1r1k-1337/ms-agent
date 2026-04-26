(function () {
    'use strict';

    let vscode;
    try {
        vscode = acquireVsCodeApi();
    } catch (error) {
        console.error('[msAgent WebView] Failed to acquire VS Code API', error);
        return;
    }

    const state = {
        sessionStartedAt: 0,
        sessionActive: false,
        hasReceivedContent: false,
        elapsedTimerId: null,
        inactivityTimeoutId: null,
        target: '准备开始下一次修复',
        subtitle: 'Agent 开始工作后，这里会先告诉你它现在在做什么。',
        phase: 'waiting',
        phaseLabel: '等待中',
        backend: '',
        mode: '',
        model: '',
        opencodeSessionId: '',
        queueState: { paused: false, hasPendingTasks: false, items: [] },
        currentActionTitle: '等待修复任务',
        currentActionDetail: 'msAgent 会持续更新 Agent 正在分析、编辑或验证的动作。',
        currentActionState: 'Idle',
        currentOutcome: 'pending',
        resultTitle: '等待结果',
        resultMessage: '修复完成后，这里会给出最关键的结果信息。',
        resultSummary: '',
        resultDiffPreview: '',
        messageNodes: new Map(),
        changes: new Map(),
    };

    const els = {};

    function initElements() {
        els.messages = document.getElementById('messages');
        els.waitingIndicator = document.getElementById('waiting-indicator');
        els.activityPanel = document.getElementById('activity-panel');
        els.resultPanel = document.getElementById('result-panel');
        els.messageContainer = document.getElementById('message-container');
        els.currentStepTitle = document.getElementById('current-step-title');
        els.currentStepDetail = document.getElementById('current-step-detail');
        els.currentStepState = document.getElementById('current-step-state');
        els.resultCard = document.getElementById('result-card');
        els.resultTitle = document.getElementById('result-title');
        els.resultMessage = document.getElementById('result-message');
        els.resultSummary = document.getElementById('result-summary');
        els.resultDiffPreview = document.getElementById('result-diff-preview');
        els.resultState = document.getElementById('result-state');
        els.technicalDetails = document.getElementById('technical-details');
        els.sessionTarget = document.getElementById('session-target');
        els.sessionSubtitle = document.getElementById('session-subtitle');
        els.sessionPhase = document.getElementById('session-phase');
        els.liveIndicator = document.getElementById('live-indicator');
        els.metaBackend = document.getElementById('meta-backend');
        els.metaMode = document.getElementById('meta-mode');
        els.metaModel = document.getElementById('meta-model');
        els.metaSession = document.getElementById('meta-session');
        els.metaElapsed = document.getElementById('meta-elapsed');
        els.metaQueue = document.getElementById('meta-queue');
        els.queueBadge = document.getElementById('queue-badge');
        els.stopBtn = document.getElementById('stopBtn');
        els.cancelBtn = document.getElementById('cancelBtn');
    }

    function log(message) {
        console.log('[msAgent WebView] ' + message);
    }

    function escapeHtml(value) {
        if (value === undefined || value === null) {
            return '';
        }
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderMarkdown(text) {
        if (!text) {
            return '';
        }
        return escapeHtml(text)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\n{2,}/g, '</p><p>')
            .replace(/\n/g, '<br>');
    }

    function scrollToBottom() {
        if (!els.messages) {
            return;
        }
        els.messages.scrollTop = els.messages.scrollHeight;
    }

    function formatDuration(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }

    function formatClock(date) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function basename(filePath) {
        if (!filePath) {
            return '';
        }
        const normalized = String(filePath).replace(/\\/g, '/');
        const parts = normalized.split('/');
        return parts[parts.length - 1] || normalized;
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

    function summarizeDiff(oldText, newText) {
        const oldLines = String(oldText || '').split('\n');
        const newLines = String(newText || '').split('\n');
        let added = 0;
        let removed = 0;
        const maxLen = Math.max(oldLines.length, newLines.length);
        for (let i = 0; i < maxLen; i += 1) {
            const oldLine = oldLines[i] || '';
            const newLine = newLines[i] || '';
            if (oldLine === newLine) {
                continue;
            }
            if (oldLine) {
                removed += 1;
            }
            if (newLine) {
                added += 1;
            }
        }
        return '+' + added + ' / -' + removed;
    }

    function formatSimpleDiff(oldText, newText) {
        if (!oldText && !newText) {
            return '(no changes)';
        }
        const oldLines = String(oldText || '').split('\n');
        const newLines = String(newText || '').split('\n');
        const output = [];
        const maxLen = Math.max(oldLines.length, newLines.length);
        for (let i = 0; i < maxLen; i += 1) {
            const oldLine = oldLines[i] || '';
            const newLine = newLines[i] || '';
            if (oldLine === newLine) {
                output.push('  ' + oldLine);
                continue;
            }
            if (oldLine) {
                output.push('- ' + oldLine);
            }
            if (newLine) {
                output.push('+ ' + newLine);
            }
        }
        return output.slice(0, 18).join('\n');
    }

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
                showWaitingState(
                    'OpenCode 暂无响应',
                    '后端可能仍在启动，或连接还没有建立。可以查看 msAgent 输出面板确认详细日志。'
                );
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
            els.metaElapsed.textContent = '耗时: ' + formatDuration(elapsed);
        }
    }

    function showWaitingState(title, detail) {
        if (els.waitingIndicator) {
            els.waitingIndicator.classList.remove('hidden');
            const titleEl = els.waitingIndicator.querySelector('.empty-title');
            const detailEl = els.waitingIndicator.querySelector('.empty-detail');
            if (titleEl) {
                titleEl.textContent = title;
            }
            if (detailEl) {
                detailEl.textContent = detail;
            }
        }
        if (els.activityPanel) {
            els.activityPanel.classList.add('hidden');
        }
        if (els.resultPanel) {
            els.resultPanel.classList.add('hidden');
        }
    }

    function showMainPanels() {
        if (els.waitingIndicator) {
            els.waitingIndicator.classList.add('hidden');
        }
        if (els.activityPanel) {
            els.activityPanel.classList.remove('hidden');
        }
    }

    function updateLiveIndicator(kind) {
        if (!els.liveIndicator) {
            return;
        }
        els.liveIndicator.className = 'live-indicator is-' + kind;
    }

    function updateHeader() {
        if (els.sessionTarget) {
            els.sessionTarget.textContent = state.target;
        }
        if (els.sessionSubtitle) {
            els.sessionSubtitle.textContent = state.subtitle;
        }
        if (els.sessionPhase) {
            els.sessionPhase.textContent = state.phaseLabel;
        }
        if (els.metaBackend) {
            els.metaBackend.textContent = 'Backend: ' + (state.backend || '-');
        }
        if (els.metaMode) {
            els.metaMode.textContent = 'Mode: ' + (state.mode || '-');
        }
        if (els.metaModel) {
            els.metaModel.textContent = 'Model: ' + (state.model || '-');
        }
        if (els.metaSession) {
            els.metaSession.textContent = 'OpenCode session: ' + (state.opencodeSessionId || '-');
        }
        if (els.metaQueue) {
            const total = state.queueState.items.length + (state.queueState.hasPendingTasks && state.queueState.items.length === 0 ? 1 : 0);
            els.metaQueue.textContent = '队列: ' + total;
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

    function updateCurrentAction(title, detail, stateLabel) {
        state.currentActionTitle = title || state.currentActionTitle;
        state.currentActionDetail = detail || state.currentActionDetail;
        state.currentActionState = stateLabel || state.currentActionState;
        if (els.currentStepTitle) {
            els.currentStepTitle.textContent = state.currentActionTitle;
        }
        if (els.currentStepDetail) {
            els.currentStepDetail.textContent = state.currentActionDetail;
        }
        if (els.currentStepState) {
            els.currentStepState.textContent = state.currentActionState;
        }
    }

    function renderResult() {
        if (!els.resultPanel || !els.resultCard || !els.resultTitle || !els.resultMessage || !els.resultSummary || !els.resultDiffPreview || !els.resultState) {
            return;
        }

        const shouldShow = state.currentOutcome !== 'pending' || state.changes.size > 0;
        els.resultPanel.classList.toggle('hidden', !shouldShow);
        if (!shouldShow) {
            return;
        }

        els.resultCard.className = 'result-card is-' + state.currentOutcome;
        els.resultTitle.textContent = state.resultTitle;
        els.resultMessage.innerHTML = renderMarkdown(state.resultMessage);
        els.resultState.textContent = state.currentOutcome === 'pending'
            ? 'Pending'
            : state.currentOutcome === 'applied'
                ? 'Applied'
                : state.currentOutcome === 'no_change'
                    ? 'No Change'
                    : 'Failed';

        if (state.resultSummary) {
            els.resultSummary.textContent = state.resultSummary;
            els.resultSummary.classList.remove('hidden');
        } else {
            els.resultSummary.textContent = '';
            els.resultSummary.classList.add('hidden');
        }

        if (state.resultDiffPreview) {
            els.resultDiffPreview.textContent = state.resultDiffPreview;
            els.resultDiffPreview.classList.remove('hidden');
        } else {
            els.resultDiffPreview.textContent = '';
            els.resultDiffPreview.classList.add('hidden');
        }
    }

    function setResult(outcome, message) {
        state.currentOutcome = outcome;
        state.resultMessage = message || '';

        if (outcome === 'applied') {
            state.resultTitle = '已应用修复';
        } else if (outcome === 'no_change') {
            state.resultTitle = '未修改代码';
        } else {
            state.resultTitle = '修复失败';
        }

        const changes = Array.from(state.changes.values());
        if (outcome === 'applied' && changes.length > 0) {
            const latest = changes[changes.length - 1];
            state.resultSummary = basename(latest.path) + ' · ' + latest.summary;
            state.resultDiffPreview = latest.preview;
        } else {
            state.resultSummary = '';
            state.resultDiffPreview = '';
        }

        renderResult();
    }

    function rememberChange(path, oldText, newText, message) {
        const preview = formatSimpleDiff(oldText, newText);
        state.changes.set(path, {
            path: path,
            summary: summarizeDiff(oldText, newText),
            preview: preview,
            message: message || '',
        });
        if (state.currentOutcome === 'applied') {
            setResult('applied', state.resultMessage || message || '已生成修复结果。');
        } else {
            renderResult();
        }
    }

    function appendTechnicalEntry(id, kind, title, body, status) {
        if (!els.messageContainer) {
            return null;
        }

        let node = state.messageNodes.get(id);
        if (!node) {
            node = document.createElement('div');
            node.className = 'tech-entry';
            node.innerHTML =
                '<div class="tech-entry-head">' +
                    '<span class="tech-entry-title"></span>' +
                    '<span class="tech-entry-kind"></span>' +
                '</div>' +
                '<div class="tech-entry-body"></div>';
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

    function appendTextStream(messageId, delta) {
        state.hasReceivedContent = true;
        const existing = state.messageNodes.get(messageId);
        const previous = existing
            ? existing.querySelector('.tech-entry-body').textContent || ''
            : '';
        appendTechnicalEntry(messageId, 'assistant', 'Assistant', previous + delta, '');
        clearInactivityTimeout();
    }

    function appendUserMessage(messageId, text) {
        state.target = text || state.target;
        state.subtitle = 'Agent 已接收当前修复目标。';
        updateHeader();
        appendTechnicalEntry(messageId, 'request', 'Fix Request', text || '', '');
    }

    function appendToolCall(messageId, toolCallId, name, params) {
        const detail = JSON.stringify(params || {}, null, 2);
        appendTechnicalEntry(toolCallId || messageId, 'tool', summarizeToolCall(name, params), detail, '');
        updateCurrentAction('正在调用 ' + name, summarizeToolCall(name, params), 'Working');
        state.phase = 'running';
        state.phaseLabel = '处理中';
        state.subtitle = summarizeToolCall(name, params);
        updateHeader();
        updateLiveIndicator('running');
        showMainPanels();
    }

    function appendToolResult(toolCallId, result, isError) {
        appendTechnicalEntry(
            toolCallId,
            'tool',
            'Tool Result',
            String(result || ''),
            isError ? 'error' : 'success'
        );
        updateCurrentAction(
            isError ? '工具调用失败' : '工具调用完成',
            summarizeToolResult(result, isError),
            isError ? 'Failed' : 'Done'
        );
        if (isError) {
            state.phaseLabel = '异常';
            updateLiveIndicator('error');
        }
        updateHeader();
    }

    function appendDiff(payload, isFinal) {
        const oldText = isFinal ? payload.oldContent : payload.oldText;
        const newText = isFinal ? payload.newContent : payload.newText;
        const diffId = (isFinal ? 'final:' : 'diff:') + payload.path;
        const title = (isFinal ? 'Final Diff' : 'Diff') + ' · ' + basename(payload.path);
        appendTechnicalEntry(diffId, 'diff', title, formatSimpleDiff(oldText, newText), 'success');
        rememberChange(payload.path, oldText, newText, payload.message || '');
        updateCurrentAction('正在整理修改结果', basename(payload.path) + ' · ' + summarizeDiff(oldText, newText), 'Reviewing');
        state.subtitle = '已生成代码修改，正在整理结果。';
        updateHeader();
        showMainPanels();
    }

    function appendFinalDiff(payload) {
        appendDiff(payload, true);
    }

    function completeMessage(_messageId) {
        scrollToBottom();
    }

    function updateStatus(phase, message) {
        state.phase = phase || state.phase;
        state.phaseLabel = phaseLabel(phase);
        if (message) {
            state.subtitle = message;
            updateCurrentAction(phaseTitle(phase), message, phaseStateLabel(phase));
        }
        updateHeader();
        updateLiveIndicator(phaseIndicator(phase));
        showMainPanels();
    }

    function updateQueueState(payload) {
        state.queueState = payload || state.queueState;
        updateHeader();
    }

    function phaseLabel(phase) {
        switch (phase) {
            case 'connecting': return '连接中';
            case 'running': return '处理中';
            case 'finalizing': return '收尾中';
            case 'error': return '异常';
            default: return '等待中';
        }
    }

    function phaseIndicator(phase) {
        switch (phase) {
            case 'running':
            case 'connecting':
            case 'finalizing':
                return 'running';
            case 'error':
                return 'error';
            default:
                return 'waiting';
        }
    }

    function phaseTitle(phase) {
        switch (phase) {
            case 'connecting': return '正在连接 OpenCode';
            case 'running': return 'Agent 正在处理';
            case 'finalizing': return '正在整理最终结果';
            case 'error': return '处理出现异常';
            default: return '等待修复任务';
        }
    }

    function phaseStateLabel(phase) {
        switch (phase) {
            case 'error': return 'Failed';
            case 'finalizing': return 'Finalizing';
            case 'connecting': return 'Connecting';
            case 'running': return 'Working';
            default: return 'Idle';
        }
    }

    function handleSessionStart(payload) {
        state.sessionStartedAt = Date.now();
        state.sessionActive = true;
        state.hasReceivedContent = false;
        state.changes.clear();
        state.currentOutcome = 'pending';
        state.resultTitle = '等待结果';
        state.resultMessage = '修复完成后，这里会给出最关键的结果信息。';
        state.resultSummary = '';
        state.resultDiffPreview = '';
        state.subtitle = 'Agent 已开始处理当前问题。';
        state.backend = payload && payload.backend ? payload.backend : state.backend;
        state.mode = payload && payload.mode ? payload.mode : state.mode;
        state.model = payload && payload.model ? payload.model : state.model;
        state.opencodeSessionId = '';
        updateCurrentAction('正在分析问题', 'Agent 已开始读取上下文并定位根因。', 'Working');
        updateHeader();
        updateLiveIndicator('running');
        showMainPanels();
        renderResult();
        startElapsedTimer();
        scheduleInactivityTimeout();
    }

    function appendSessionResult(outcome, finalMessage) {
        const normalized = outcome || 'failed';
        state.sessionActive = false;
        clearInactivityTimeout();
        stopElapsedTimer();
        if (normalized === 'applied') {
            updateCurrentAction('修复已完成', finalMessage || 'OpenCode 已应用修复。', 'Done');
            updateLiveIndicator('success');
            state.phaseLabel = '完成';
        } else if (normalized === 'no_change') {
            updateCurrentAction('未修改代码', finalMessage || 'OpenCode 认为当前问题不需要改动。', 'No Change');
            updateLiveIndicator('warning');
            state.phaseLabel = '未修改';
        } else {
            updateCurrentAction('修复失败', finalMessage || 'OpenCode 未能完成修复。', 'Failed');
            updateLiveIndicator('error');
            state.phaseLabel = '失败';
        }
        state.subtitle = finalMessage || state.subtitle;
        updateHeader();
        setResult(normalized, finalMessage || '');
    }

    function clearAll() {
        clearInactivityTimeout();
        stopElapsedTimer();
        state.sessionStartedAt = 0;
        state.sessionActive = false;
        state.hasReceivedContent = false;
        state.target = '准备开始下一次修复';
        state.subtitle = 'Agent 开始工作后，这里会先告诉你它现在在做什么。';
        state.phase = 'waiting';
        state.phaseLabel = '等待中';
        state.backend = '';
        state.mode = '';
        state.model = '';
        state.opencodeSessionId = '';
        state.currentActionTitle = '等待修复任务';
        state.currentActionDetail = 'msAgent 会持续更新 Agent 正在分析、编辑或验证的动作。';
        state.currentActionState = 'Idle';
        state.currentOutcome = 'pending';
        state.resultTitle = '等待结果';
        state.resultMessage = '修复完成后，这里会给出最关键的结果信息。';
        state.resultSummary = '';
        state.resultDiffPreview = '';
        state.changes.clear();
        state.messageNodes.clear();

        if (els.messageContainer) {
            els.messageContainer.innerHTML = '';
        }
        updateCurrentAction(state.currentActionTitle, state.currentActionDetail, state.currentActionState);
        updateHeader();
        updateLiveIndicator('waiting');
        renderResult();
        showWaitingState('等待 Agent 开始', '执行修复命令后，这里会立即显示当前动作和结果。');
    }

    function handleMessage(message) {
        if (!message || !message.type) {
            return;
        }
        log('handleMessage ' + message.type);
        switch (message.type) {
            case 'session_start':
                handleSessionStart(message.payload || {});
                break;
            case 'backend_info':
                state.backend = message.payload && message.payload.backend ? message.payload.backend : state.backend;
                state.mode = message.payload && message.payload.mode ? message.payload.mode : state.mode;
                state.model = message.payload && message.payload.model ? message.payload.model : state.model;
                updateHeader();
                break;
            case 'session_metadata':
                state.opencodeSessionId = message.payload && message.payload.opencodeSessionId
                    ? message.payload.opencodeSessionId
                    : state.opencodeSessionId;
                updateHeader();
                break;
            case 'status':
                updateStatus(
                    message.payload && message.payload.phase,
                    message.payload && message.payload.message
                );
                break;
            case 'step_update':
                updateCurrentAction(
                    phaseTitle('running'),
                    message.payload && message.payload.detail ? message.payload.detail : String(message.payload && message.payload.step || ''),
                    'Working'
                );
                showMainPanels();
                break;
            case 'tool_call':
                appendToolCall(
                    message.payload && message.payload.messageId,
                    message.payload && message.payload.toolCallId,
                    message.payload && message.payload.name,
                    message.payload && message.payload.params
                );
                break;
            case 'tool_result':
                appendToolResult(
                    message.payload && message.payload.toolCallId,
                    message.payload && message.payload.result,
                    !!(message.payload && message.payload.isError)
                );
                break;
            case 'diff':
                appendDiff(message.payload || {}, false);
                break;
            case 'final_diff':
                appendFinalDiff(message.payload || {});
                break;
            case 'session_end':
                appendSessionResult(
                    message.payload && message.payload.outcome,
                    message.payload && message.payload.finalMessage
                );
                break;
            case 'error':
                appendSessionResult('failed', message.payload && message.payload.message ? message.payload.message : 'Unknown error');
                appendTechnicalEntry('error:' + Date.now(), 'error', 'Error', message.payload && message.payload.message ? message.payload.message : 'Unknown error', 'error');
                break;
            case 'clear':
                clearAll();
                break;
            case 'text_stream':
                appendTextStream(message.payload && message.payload.messageId, message.payload && message.payload.delta || '');
                break;
            case 'user_message':
                appendUserMessage(message.payload && message.payload.messageId, message.payload && message.payload.text || '');
                break;
            case 'message_complete':
                completeMessage(message.payload && message.payload.messageId);
                break;
            case 'queue_state':
                updateQueueState(message.payload || {});
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

    function initialize() {
        initElements();
        bindEvents();
        updateCurrentAction(state.currentActionTitle, state.currentActionDetail, state.currentActionState);
        updateHeader();
        renderResult();
        showWaitingState('等待 Agent 开始', '执行修复命令后，这里会立即显示当前动作和结果。');
        updateLiveIndicator('waiting');
        vscode.postMessage({ type: 'fix_details_ready' });
    }

    initialize();
}());
