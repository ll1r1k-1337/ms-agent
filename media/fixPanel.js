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
        connecting: 'Starting OpenCode',
        running: 'Repairing',
        finalizing: 'Verifying changes',
        error: 'Error',
        waiting: 'Ready',
        completed: 'Completed',
        no_change: 'No code change needed',
        failed: 'Failed',
        cancelled: 'Cancelled',
        idle: 'Ready',
    };

    const state = {
        sessionStartedAt: 0,
        sessionActive: false,
        hasReceivedContent: false,
        elapsedTimerId: null,
        inactivityTimeoutId: null,
        target: '',
        phase: 'waiting',
        currentOutcome: 'pending',
        finalMessage: '',
        finalExplanation: '',
        finalExplanationKind: '',
        backend: '',
        mode: '',
        model: '',
        activeRunId: '',
        terminalLocked: false,
        opencodeSessionId: '',
        queueState: { paused: false, hasPendingTasks: false, items: [] },
        changes: new Map(),
        explanation: '',
        explanationMessages: new Map(),
        explanationOrder: [],
        collapsedCards: {
            status: false,
            files: false,
            explanation: false,
        },
        userPinnedToBottom: true,
    };

    const els = {};

    function $(id) { return document.getElementById(id); }

    function initElements() {
        els.messages = $('messages');
        els.jumpLatest = $('jump-latest');
        els.statusPill = $('status-pill');
        els.statusLabel = $('status-label');
        els.statusProgress = $('status-progress');
        els.metaTarget = $('meta-target');
        els.metaBackend = $('meta-backend');
        els.metaMode = $('meta-mode');
        els.metaModel = $('meta-model');
        els.metaSession = $('meta-session');
        els.metaElapsed = $('meta-elapsed');
        els.elapsedRow = $('elapsed-row');
        els.queueRow = $('queue-row');
        els.queueBadge = $('queue-badge');
        els.actionRow = $('action-row');
        els.stopBtn = $('stopBtn');
        els.cancelBtn = $('cancelBtn');
        els.statusCard = $('status-card');
        els.filesCard = $('files-card');
        els.filesList = $('files-list');
        els.filesMeta = $('files-meta');
        els.tasksCard = $('tasks-card');
        els.tasksMeta = $('tasks-meta');
        els.tasksRunningGroup = $('tasks-running-group');
        els.tasksRunningCount = $('tasks-running-count');
        els.tasksRunningList = $('tasks-running-list');
        els.tasksQueuedGroup = $('tasks-queued-group');
        els.tasksQueuedCount = $('tasks-queued-count');
        els.tasksQueuedList = $('tasks-queued-list');
        els.tasksCompletedGroup = $('tasks-completed-group');
        els.tasksCompletedCount = $('tasks-completed-count');
        els.tasksCompletedList = $('tasks-completed-list');
        els.explanationCard = $('explanation-card');
        els.explanationBody = $('explanation-body');
        els.explanationMeta = $('explanation-meta');
        els.idleHint = $('idle-hint');
        els.collapseToggles = Array.prototype.slice.call(document.querySelectorAll('[data-card-toggle]'));
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
        if (!filePath) return '';
        const normalized = String(filePath).replace(/\\/g, '/');
        const parts = normalized.split('/');
        return parts[parts.length - 1] || normalized;
    }

    function dirname(filePath) {
        if (!filePath) return '';
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
        if (!object || typeof object !== 'object') return '';
        for (let i = 0; i < keys.length; i += 1) {
            const value = object[keys[i]];
            if (typeof value === 'string' && value.trim()) return value;
        }
        return '';
    }

    function summarizeToolCall(name, params) {
        const pathValue = firstString(params, ['path', 'filePath', 'uri', 'command']);
        if (pathValue) return name.replace(/_/g, ' ') + ' · ' + basename(pathValue);
        return name.replace(/_/g, ' ');
    }

    function summarizeToolResult(result, isError) {
        const normalized = String(result || '').trim().replace(/\s+/g, ' ');
        if (!normalized) return isError ? 'Tool returned an error.' : 'Tool finished.';
        return normalized.length > 140 ? normalized.slice(0, 137) + '...' : normalized;
    }

    function diffStat(oldText, newText) {
        if (oldText === newText) return { added: 0, removed: 0 };
        const oldLines = String(oldText || '').split('\n');
        const newLines = String(newText || '').split('\n');
        const ops = computeLineDiff(oldLines, newLines);
        let added = 0;
        let removed = 0;
        for (let i = 0; i < ops.length; i += 1) {
            if (ops[i].type === 'add') added += 1;
            else if (ops[i].type === 'del') removed += 1;
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
        if (oldText === newText) {
            return [{ type: 'meta', text: '(no textual changes)' }];
        }

        // Build an LCS-based edit script so only truly-changed lines are marked.
        const ops = computeLineDiff(oldLines, newLines);
        if (!ops.some(function (op) { return op.type !== 'eq'; })) {
            return [{ type: 'meta', text: '(no textual changes)' }];
        }

        // Group ops into hunks: keep CONTEXT_LINES of equal context around changes,
        // collapse longer equal runs into a "@@ skipped N lines @@" marker.
        const CONTEXT_LINES = 3;
        const hunks = collectHunks(ops, CONTEXT_LINES);

        const out = [];
        for (let h = 0; h < hunks.length; h += 1) {
            const hunk = hunks[h];
            if (hunk.skipBefore > 0) {
                out.push({ type: 'meta', text: '@@ skipped ' + hunk.skipBefore + ' lines @@' });
            }
            for (let i = 0; i < hunk.ops.length; i += 1) {
                const op = hunk.ops[i];
                if (op.type === 'eq') {
                    out.push({ type: 'ctx', text: '  ' + op.line });
                } else if (op.type === 'del') {
                    out.push({ type: 'del', text: '- ' + op.line });
                } else if (op.type === 'add') {
                    out.push({ type: 'add', text: '+ ' + op.line });
                }
            }
            if (h === hunks.length - 1 && hunk.skipAfter > 0) {
                out.push({ type: 'meta', text: '@@ skipped ' + hunk.skipAfter + ' lines @@' });
            }
        }
        return out;
    }

    // Classic LCS dynamic programming: O(n*m) time and memory.
    // Returns ops in source order: { type: 'eq' | 'del' | 'add', line: string }.
    function computeLineDiff(a, b) {
        const n = a.length;
        const m = b.length;
        // dp[i][j] = LCS length of a[0..i-1] and b[0..j-1]
        const dp = new Array(n + 1);
        for (let i = 0; i <= n; i += 1) {
            dp[i] = new Int32Array(m + 1);
        }
        for (let i = 1; i <= n; i += 1) {
            const row = dp[i];
            const prev = dp[i - 1];
            const ai = a[i - 1];
            for (let j = 1; j <= m; j += 1) {
                if (ai === b[j - 1]) {
                    row[j] = prev[j - 1] + 1;
                } else {
                    row[j] = prev[j] >= row[j - 1] ? prev[j] : row[j - 1];
                }
            }
        }
        const ops = [];
        let i = n;
        let j = m;
        while (i > 0 && j > 0) {
            if (a[i - 1] === b[j - 1]) {
                ops.push({ type: 'eq', line: a[i - 1] });
                i -= 1;
                j -= 1;
            } else if (dp[i - 1][j] >= dp[i][j - 1]) {
                ops.push({ type: 'del', line: a[i - 1] });
                i -= 1;
            } else {
                ops.push({ type: 'add', line: b[j - 1] });
                j -= 1;
            }
        }
        while (i > 0) {
            ops.push({ type: 'del', line: a[i - 1] });
            i -= 1;
        }
        while (j > 0) {
            ops.push({ type: 'add', line: b[j - 1] });
            j -= 1;
        }
        ops.reverse();
        return ops;
    }

    // Slice the op stream into hunks separated by long stretches of unchanged lines.
    // Each hunk keeps `context` lines of surrounding context.
    function collectHunks(ops, context) {
        const changeIdx = [];
        for (let i = 0; i < ops.length; i += 1) {
            if (ops[i].type !== 'eq') changeIdx.push(i);
        }
        if (changeIdx.length === 0) {
            return [];
        }
        const hunks = [];
        let cursor = 0;
        let prevHunkEnd = -1;
        while (cursor < changeIdx.length) {
            const startChange = changeIdx[cursor];
            // expand window forward, merging adjacent changes within 2*context
            let endChange = startChange;
            let next = cursor + 1;
            while (next < changeIdx.length && changeIdx[next] - endChange <= 2 * context) {
                endChange = changeIdx[next];
                next += 1;
            }
            const hunkStart = Math.max(0, startChange - context);
            const hunkEnd = Math.min(ops.length - 1, endChange + context);
            const slice = ops.slice(hunkStart, hunkEnd + 1);
            const skipBefore = hunkStart - (prevHunkEnd + 1);
            hunks.push({
                ops: slice,
                skipBefore: skipBefore > 0 ? skipBefore : 0,
                skipAfter: ops.length - 1 - hunkEnd,
            });
            prevHunkEnd = hunkEnd;
            cursor = next;
        }
        return hunks;
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
            if (!trimmed) return '';
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

    function stripStructuredHeading(text, heading) {
        const pattern = new RegExp('^' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*', 'i');
        return String(text || '').replace(pattern, '').trim();
    }

    function isProgressMessageId(messageId) {
        return /_progress$/.test(String(messageId || ''));
    }

    function getExplanationText() {
        const chunks = state.explanationOrder
            .map(function (messageId) { return state.explanationMessages.get(messageId) || ''; })
            .map(function (text) { return String(text || '').trim(); })
            .filter(Boolean);
        if (chunks.length > 0) {
            return chunks.join('\n\n').trim();
        }
        return String(state.explanation || '').trim();
    }

    function parseExplanationSections(text, finalMessage, outcome) {
        const raw = String(text || '').trim();
        const fallback = String(finalMessage || '').trim();
        const source = raw || fallback;
        const sections = {
            problem: '',
            fix: '',
            why: '',
            notes: '',
            hasStructuredHeadings: false,
            raw: source,
        };

        if (!source) {
            return sections;
        }

        const headingPattern = /^(Problem|Fix|Why it works|Notes)\s*:\s*/gim;
        const matches = [];
        let match;
        while ((match = headingPattern.exec(source)) !== null) {
            matches.push({
                key: match[1].toLowerCase(),
                start: match.index,
                end: headingPattern.lastIndex,
            });
        }

        if (matches.length > 0) {
            sections.hasStructuredHeadings = true;
            for (let i = 0; i < matches.length; i += 1) {
                const current = matches[i];
                const next = matches[i + 1];
                const content = source.slice(current.start, next ? next.start : source.length).trim();
                if (current.key === 'problem') sections.problem = stripStructuredHeading(content, 'Problem');
                if (current.key === 'fix') sections.fix = stripStructuredHeading(content, 'Fix');
                if (current.key === 'why it works') sections.why = stripStructuredHeading(content, 'Why it works');
                if (current.key === 'notes') sections.notes = stripStructuredHeading(content, 'Notes');
            }
            return sections;
        }

        if (outcome === 'applied') {
            sections.fix = source;
            return sections;
        }

        sections.problem = source;
        return sections;
    }

    function explanationSectionHtml(title, text) {
        if (!text) {
            return '';
        }
        return '<section class="explanation-section">'
            + '<h4 class="explanation-section-title">' + escapeHtml(title) + '</h4>'
            + '<div class="explanation-section-body">' + renderInlineMarkdown(text) + '</div>'
            + '</section>';
    }

    function scrollToBottom() {
        if (!els.messages) return;
        els.messages.scrollTop = els.messages.scrollHeight;
        updateJumpLatestVisibility();
    }

    function isPinnedToBottom() {
        if (!els.messages) return true;
        const el = els.messages;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        // Generous threshold: within 80px counts as "at the bottom".
        return distanceFromBottom <= 80;
    }

    function maybeStickyScroll() {
        if (!els.messages) return;
        if (state.userPinnedToBottom) {
            // Defer to next frame so newly-rendered content is measured.
            requestAnimationFrame(function () {
                els.messages.scrollTop = els.messages.scrollHeight;
                updateJumpLatestVisibility();
            });
        } else {
            updateJumpLatestVisibility();
        }
    }

    function updateJumpLatestVisibility() {
        if (!els.jumpLatest || !els.messages) return;
        const overflowing = els.messages.scrollHeight - els.messages.clientHeight > 8;
        const shouldShow = overflowing && !isPinnedToBottom() && state.sessionActive;
        els.jumpLatest.classList.toggle('is-visible', shouldShow);
    }

    function shouldIgnoreCollapseToggle(target) {
        if (!target || typeof target.closest !== 'function') {
            return false;
        }
        return Boolean(target.closest('button, summary, a, code, pre, input, textarea, select'));
    }

    function renderCollapsedCards() {
        if (els.statusCard) {
            els.statusCard.classList.toggle('is-collapsed', !!state.collapsedCards.status);
        }
        if (els.filesCard) {
            els.filesCard.classList.toggle('is-collapsed', !!state.collapsedCards.files);
        }
        if (els.explanationCard) {
            els.explanationCard.classList.toggle('is-collapsed', !!state.collapsedCards.explanation);
        }
    }

    function toggleCardCollapse(cardId) {
        if (!Object.prototype.hasOwnProperty.call(state.collapsedCards, cardId)) {
            return;
        }
        state.collapsedCards[cardId] = !state.collapsedCards[cardId];
        renderCollapsedCards();
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
                renderStatusCard();
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
        if (state.currentOutcome === 'cancelled' || state.phase === 'cancelled') return 'warning';
        if (state.phase === 'running' || state.phase === 'connecting' || state.phase === 'finalizing') {
            return 'running';
        }
        return 'waiting';
    }

    function renderStatusCard() {
        // Pill
        if (els.statusPill && els.statusLabel) {
            els.statusPill.className = 'status-pill is-' + phaseToPillKind();
            els.statusLabel.textContent = PHASE_LABELS[state.phase] || PHASE_LABELS.waiting;
        }
        // Kv-rows
        if (els.metaTarget) {
            const t = state.target || '-';
            els.metaTarget.textContent = t;
            els.metaTarget.title = t;
        }
        if (els.metaBackend) els.metaBackend.textContent = state.backend || '-';
        if (els.metaMode) els.metaMode.textContent = state.mode || '-';
        if (els.metaModel) els.metaModel.textContent = state.model || '-';
        if (els.metaSession) {
            const sid = state.opencodeSessionId || '';
            els.metaSession.textContent = sid || '-';
            els.metaSession.title = sid;
        }
        // Elapsed (visible only while session is active or just ended this run)
        if (els.elapsedRow) {
            els.elapsedRow.classList.toggle('hidden', state.sessionStartedAt === 0);
        }
        // Queue (visible only when queue has items)
        const queued = (state.queueState.items || []).length;
        if (els.queueRow) {
            els.queueRow.classList.toggle('hidden', queued === 0);
        }
        if (els.queueBadge) {
            els.queueBadge.textContent = String(queued);
        }
        // Action row (visible only when there's queued work)
        if (els.actionRow) {
            els.actionRow.classList.toggle('hidden', !state.queueState.hasPendingTasks);
        }
        if (els.stopBtn) {
            els.stopBtn.textContent = state.queueState.paused ? 'Resume' : 'Pause';
        }
        // Progress shimmer (visible while in-flight)
        if (els.statusProgress) {
            const inFlight = state.phase === 'running'
                || state.phase === 'connecting'
                || state.phase === 'finalizing';
            els.statusProgress.classList.toggle('hidden', !inFlight);
        }
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
        els.filesList.innerHTML = files.map(fileHtml).join('');
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
        return '<details class="file-item">'
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
        const finished = state.currentOutcome !== 'pending';
        if (!finished) {
            els.explanationCard.classList.add('hidden');
            return;
        }
        const text = String(state.finalExplanation || state.finalMessage || '').trim();
        if (!text) {
            els.explanationCard.classList.add('hidden');
            return;
        }
        const sections = parseExplanationSections(text, state.finalMessage, state.currentOutcome);
        let html = '';
        if (state.currentOutcome === 'applied') {
            if ((state.finalExplanationKind === 'structured' || state.finalExplanationKind === 'synthetic') && sections.hasStructuredHeadings) {
                html = [
                    explanationSectionHtml('Problem Explanation', sections.problem),
                    explanationSectionHtml('Fix Explanation', sections.fix),
                    explanationSectionHtml('Why it works', sections.why),
                    explanationSectionHtml('Notes', sections.notes),
                ].filter(Boolean).join('');
            } else if (sections.hasStructuredHeadings) {
                html = [
                    explanationSectionHtml('Problem Explanation', sections.problem),
                    explanationSectionHtml('Fix Explanation', sections.fix),
                    explanationSectionHtml('Why it works', sections.why),
                    explanationSectionHtml('Notes', sections.notes),
                ].filter(Boolean).join('');
            } else {
                html = explanationSectionHtml('Full Explanation', sections.raw);
            }
        } else if (state.currentOutcome === 'failed' && !sections.hasStructuredHeadings) {
            html = explanationSectionHtml('Failure Reason', sections.raw);
        } else if (state.currentOutcome === 'no_change' && !sections.hasStructuredHeadings) {
            html = explanationSectionHtml('Final Explanation', sections.raw);
        } else {
            html = explanationSectionHtml('Full Explanation', sections.raw);
        }
        if (!html) {
            els.explanationCard.classList.add('hidden');
            return;
        }
        els.explanationCard.classList.remove('hidden');
        els.explanationBody.classList.remove('is-empty');
        els.explanationBody.innerHTML = html;
        els.explanationMeta.textContent = finished ? 'Final' : 'Streaming…';
    }

    function renderIdleHint() {
        if (!els.idleHint) return;
        const hasContent = state.sessionActive
            || state.changes.size > 0
            || state.explanation
            || state.currentOutcome !== 'pending'
            || state.hasReceivedContent;
        els.idleHint.classList.toggle('hidden', hasContent);
    }

    function renderAll() {
        renderStatusCard();
        renderTasksCard();
        renderFiles();
        renderExplanation();
        renderIdleHint();
        renderCollapsedCards();
    }

    // ── handlers ─────────────────────────────────────────────────

    function appendTextStream(messageId, delta) {
        if (!delta) return;
        state.hasReceivedContent = true;
        clearInactivityTimeout();
        if (isProgressMessageId(messageId)) {
            renderIdleHint();
            return;
        }
        if (!state.explanationMessages.has(messageId)) {
            state.explanationOrder.push(messageId);
            state.explanationMessages.set(messageId, '');
        }
        state.explanationMessages.set(messageId, (state.explanationMessages.get(messageId) || '') + delta);
        state.explanation = getExplanationText();
        renderExplanation();
        renderIdleHint();
        maybeStickyScroll();
        // messageId is part of the protocol but the panel does not segment by id.
        void messageId;
    }

    function appendUserMessage(messageId, text) {
        if (text) state.target = text;
        renderStatusCard();
        renderIdleHint();
        void messageId;
    }

    // Kept as a named no-op so prior tests / internal callers still resolve.
    function updateCurrentAction(_label) {
        // intentionally empty: actions are reflected via phase + progress shimmer
    }

    function appendToolCall(messageId, toolCallId, name, params) {
        state.phase = 'running';
        state.hasReceivedContent = true;
        clearInactivityTimeout();
        log('tool_call ' + summarizeToolCall(name, params || {}));
        renderStatusCard();
        renderIdleHint();
        void messageId;
        void toolCallId;
    }

    function appendToolResult(toolCallId, result, isError) {
        if (isError) {
            state.phase = 'error';
            log('tool_result error ' + summarizeToolResult(result, true));
        }
        renderStatusCard();
        void toolCallId;
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
        if (isFinal && payload.message && !getExplanationText()) {
            state.explanation = payload.message;
        }
        state.hasReceivedContent = true;
        renderFiles();
        renderExplanation();
        renderIdleHint();
        maybeStickyScroll();
    }

    function appendFinalDiff(payload) {
        appendDiff(payload, true);
    }

    function completeMessage(_messageId) {
        state.explanation = getExplanationText();
        scrollToBottom();
    }

    function updateStatus(phase, message) {
        if (
            state.terminalLocked
            && (phase === 'running' || phase === 'connecting' || phase === 'finalizing')
        ) {
            return;
        }
        if (phase) state.phase = phase;
        if (message) updateCurrentAction(message);
        renderStatusCard();
        renderIdleHint();
    }

    function updateQueueState(payload) {
        state.queueState = payload || state.queueState;
        renderStatusCard();
        renderTasksCard();
    }

    function renderTasksCard() {
        if (!els.tasksCard) return;
        const queue = state.queueState || {};
        const running = Array.isArray(queue.runningTasks) ? queue.runningTasks : [];
        const queued = Array.isArray(queue.items) ? queue.items : [];
        const completed = Array.isArray(queue.recentlyCompleted) ? queue.recentlyCompleted : [];

        // Show the card whenever any of the three groups has at least one
        // entry — otherwise keep it hidden so the panel doesn't get noisy for
        // a one-off single-issue fix.
        const hasAny = running.length > 0 || queued.length > 0 || completed.length > 0;
        els.tasksCard.classList.toggle('hidden', !hasAny);

        if (els.tasksMeta) {
            els.tasksMeta.textContent =
                running.length + ' in progress · ' + completed.length + ' completed';
        }
        renderTasksGroup(els.tasksRunningGroup, els.tasksRunningCount, els.tasksRunningList, running, 'running');
        renderTasksGroup(els.tasksQueuedGroup, els.tasksQueuedCount, els.tasksQueuedList, queued, 'queued');
        renderTasksGroup(els.tasksCompletedGroup, els.tasksCompletedCount, els.tasksCompletedList, completed, 'completed');
    }

    function renderTasksGroup(group, count, list, tasks, kind) {
        if (!group || !list) return;
        group.classList.toggle('hidden', tasks.length === 0);
        if (count) count.textContent = String(tasks.length);
        list.textContent = '';
        for (const task of tasks) {
            list.appendChild(buildTaskListItem(task, kind));
        }
    }

    function buildTaskListItem(task, kind) {
        const li = document.createElement('li');
        const status = kind === 'completed' && task && task.status ? task.status : kind;
        li.className = 'tasks-list-item is-' + status;

        const icon = document.createElement('span');
        icon.className = 'task-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = taskIconSvg(status);
        li.appendChild(icon);

        const title = document.createElement('span');
        title.className = 'task-title';
        title.title = (task && task.title) || '';
        title.textContent = (task && task.title) || '(untitled)';
        li.appendChild(title);

        if (kind === 'completed') {
            const badge = document.createElement('span');
            badge.className = 'task-badge';
            badge.textContent = badgeLabelForStatus(status);
            li.appendChild(badge);
        }
        return li;
    }

    function badgeLabelForStatus(status) {
        switch (status) {
            case 'completed': return 'Applied';
            case 'no_change': return 'No change';
            case 'failed':    return 'Failed';
            case 'cancelled': return 'Cancelled';
            case 'stopped':   return 'Stopped';
            default:          return status;
        }
    }

    function taskIconSvg(status) {
        switch (status) {
            case 'running':
                return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
            case 'queued':
                return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg>';
            case 'completed':
                return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="5 12 10 17 19 7"/></svg>';
            case 'no_change':
                return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="12" x2="18" y2="12"/></svg>';
            case 'failed':
                return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
            case 'cancelled':
            case 'stopped':
                return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><line x1="8" y1="8" x2="16" y2="16"/></svg>';
            default:
                return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/></svg>';
        }
    }

    function handleSessionStart(payload) {
        state.sessionStartedAt = Date.now();
        state.sessionActive = true;
        state.hasReceivedContent = false;
        state.changes = new Map();
        state.explanation = '';
        state.explanationMessages = new Map();
        state.explanationOrder = [];
        state.currentOutcome = 'pending';
        state.finalMessage = '';
        state.finalExplanation = '';
        state.finalExplanationKind = '';
        state.phase = 'connecting';
        state.terminalLocked = false;
        state.opencodeSessionId = '';
        state.userPinnedToBottom = true;
        state.backend = (payload && payload.backend) || state.backend;
        state.mode = (payload && payload.mode) || state.mode;
        state.model = (payload && payload.model) || state.model;
        renderAll();
        startElapsedTimer();
        scheduleInactivityTimeout();
    }

    function appendSessionResult(outcome, finalMessage, explanationKind) {
        const normalized = outcome || 'failed';
        state.sessionActive = false;
        state.currentOutcome = normalized;
        state.finalMessage = finalMessage || '';
        state.finalExplanation = finalMessage || state.finalExplanation;
        state.finalExplanationKind = explanationKind || state.finalExplanationKind || '';
        if (normalized === 'applied') state.phase = 'completed';
        else if (normalized === 'no_change') state.phase = 'no_change';
        else if (normalized === 'cancelled') state.phase = 'cancelled';
        else state.phase = 'failed';
        state.terminalLocked = true;
        if (finalMessage && !getExplanationText()) state.explanation = finalMessage;
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
        state.target = '';
        state.phase = 'waiting';
        state.currentOutcome = 'pending';
        state.finalMessage = '';
        state.finalExplanation = '';
        state.finalExplanationKind = '';
        state.backend = '';
        state.mode = '';
        state.model = '';
        state.activeRunId = '';
        state.terminalLocked = false;
        state.opencodeSessionId = '';
        state.changes = new Map();
        state.explanation = '';
        state.explanationMessages = new Map();
        state.explanationOrder = [];
        state.collapsedCards = {
            status: false,
            files: false,
            explanation: false,
        };
        state.userPinnedToBottom = true;
        state.queueState = { paused: false, hasPendingTasks: false, items: [], runningTasks: [], recentlyCompleted: [] };
        if (els.metaElapsed) els.metaElapsed.textContent = '00:00';
        if (els.jumpLatest) els.jumpLatest.classList.remove('is-visible');
        renderAll();
    }

    function handleMessage(message) {
        if (!message || !message.type) return;
        const runId = typeof message.runId === 'string' ? message.runId : '';
        if (message.type === 'session_start' && runId) {
            state.activeRunId = runId;
            state.terminalLocked = false;
        }
        if (
            message.type !== 'queue_state'
            && message.type !== 'clear'
            && runId
            && state.activeRunId
            && runId !== state.activeRunId
        ) {
            return;
        }
        if (state.terminalLocked) {
            if (message.type === 'session_end') {
                return;
            }
            if (message.type === 'step_update' || message.type === 'tool_call' || message.type === 'tool_result') {
                return;
            }
            if (message.type === 'status') {
                const guardedPhase = firstString(message.payload || {}, ['phase']);
                if (guardedPhase === 'running' || guardedPhase === 'connecting' || guardedPhase === 'finalizing') {
                    return;
                }
            }
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
                appendSessionResult(p.outcome, p.finalMessage, p.explanationKind);
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
                if (p.message) {
                    state.finalExplanation = p.message;
                }
                if (p.explanationKind) {
                    state.finalExplanationKind = p.explanationKind;
                }
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
        if (els.collapseToggles) {
            els.collapseToggles.forEach(function (node) {
                node.addEventListener('dblclick', function (event) {
                    if (shouldIgnoreCollapseToggle(event.target)) {
                        return;
                    }
                    const cardId = node.getAttribute('data-card-toggle');
                    if (!cardId) {
                        return;
                    }
                    event.preventDefault();
                    toggleCardCollapse(cardId);
                });
            });
        }
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
        if (els.messages) {
            els.messages.addEventListener('scroll', function () {
                state.userPinnedToBottom = isPinnedToBottom();
                updateJumpLatestVisibility();
            }, { passive: true });
        }
        if (els.jumpLatest) {
            els.jumpLatest.addEventListener('click', function () {
                state.userPinnedToBottom = true;
                scrollToBottom();
            });
        }
        window.addEventListener('message', function (event) {
            handleMessage(event.data);
        });
    }

    function renderResult() {
        // Backward-compatible alias retained for existing test entry points.
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
