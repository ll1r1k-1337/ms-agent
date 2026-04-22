export const fixDetailsScript = `
        var vscode = acquireVsCodeApi();
        var els = {
            backendBadge: document.getElementById("backendBadge"),
            degradedBanner: document.getElementById("degradedBanner"),
            phaseIndicator: document.getElementById("phaseIndicator"),
            timeline: document.getElementById("timeline"),
            diffCards: document.getElementById("diffCards"),
            sessionResult: document.getElementById("sessionResult"),
            messages: document.getElementById("messages"),
            stopBtn: document.getElementById("stopBtn"),
            cancelBtn: document.getElementById("cancelBtn"),
            queuePanel: document.getElementById("queuePanel"),
            queueHeader: document.getElementById("queueHeader"),
            queueBody: document.getElementById("queueBody"),
        };
        var container = els.messages;
        var debugInfo = document.getElementById("debug-info");
        var messageMap = new Map();
        var toolCallMap = new Map();
        var queueExpanded = false;
        var lastQueueHeaderBody = "0 problems queued";

        function log(msg) {
            console.log("[WebView] " + msg);
            if (debugInfo) debugInfo.textContent = msg;
        }

        log("Script loaded");

        // --- Session State (inline mirror of sessionState.ts) ---
        function createInitialState() {
            return {
                backend: '',
                mode: '',
                degraded: false,
                phase: 'idle',
                phaseMessage: '',
                steps: [],
                diffCards: [],
                completed: false,
                success: undefined,
                finalMessage: '',
                startedAt: 0
            };
        }

        function phaseToTimelineType(phase) {
            var known = ['planning', 'reading_files', 'calling_tools', 'editing', 'verifying', 'completed', 'failed', 'cancelled', 'tool_call', 'tool_result'];
            if (known.indexOf(phase) >= 0) {
                return phase;
            }
            return 'calling_tools';
        }

        function reduceSessionState(state, message) {
            var payload = message.payload;
            switch (message.type) {
                case 'session_start':
                    return {
                        ...state,
                        backend: payload.backend,
                        mode: payload.mode || '',
                        completed: false,
                        success: undefined,
                        startedAt: Date.now()
                    };
                case 'backend_info':
                    return {
                        ...state,
                        backend: payload.backend,
                        mode: payload.mode,
                        degraded: payload.degraded || false
                    };
                case 'status':
                    return {
                        ...state,
                        phase: payload.phase,
                        phaseMessage: payload.message || ''
                    };
                case 'step_update': {
                    var step = {
                        id: payload.step + '-' + Date.now(),
                        type: phaseToTimelineType(payload.step),
                        title: payload.step,
                        detail: payload.detail,
                        status: 'running',
                        timestamp: Date.now()
                    };
                    return {
                        ...state,
                        steps: state.steps.concat([step])
                    };
                }
                case 'tool_call': {
                    var step = {
                        id: payload.toolCallId,
                        type: 'tool_call',
                        title: payload.name,
                        detail: JSON.stringify(payload.params),
                        status: 'running',
                        timestamp: Date.now()
                    };
                    return {
                        ...state,
                        steps: state.steps.concat([step])
                    };
                }
                case 'tool_result': {
                    var updatedSteps = state.steps.map(function(s) {
                        if (s.id === payload.toolCallId) {
                            return {
                                ...s,
                                status: payload.isError ? 'error' : 'success'
                            };
                        }
                        return s;
                    });
                    return {
                        ...state,
                        steps: updatedSteps
                    };
                }
                case 'diff': {
                    var card = {
                        id: payload.toolCallId,
                        path: payload.path,
                        oldText: payload.oldText,
                        newText: payload.newText,
                        changeSummary: computeChangeSummary(payload.oldText, payload.newText)
                    };
                    return {
                        ...state,
                        diffCards: state.diffCards.concat([card])
                    };
                }
                case 'final_diff': {
                    var existingIndex = -1;
                    for (var i = 0; i < state.diffCards.length; i++) {
                        if (state.diffCards[i].path === payload.path) {
                            existingIndex = i;
                            break;
                        }
                    }
                    if (existingIndex >= 0) {
                        var updatedCards = state.diffCards.slice();
                        updatedCards[existingIndex] = {
                            ...updatedCards[existingIndex],
                            oldText: payload.oldContent,
                            newText: payload.newContent,
                            changeSummary: computeChangeSummary(payload.oldContent, payload.newContent)
                        };
                        return {
                            ...state,
                            diffCards: updatedCards
                        };
                    }
                    var card = {
                        id: 'final-' + Date.now(),
                        path: payload.path,
                        oldText: payload.oldContent,
                        newText: payload.newContent,
                        changeSummary: computeChangeSummary(payload.oldContent, payload.newContent)
                    };
                    return {
                        ...state,
                        diffCards: state.diffCards.concat([card])
                    };
                }
                case 'session_end':
                    return {
                        ...state,
                        completed: true,
                        success: payload.success,
                        finalMessage: payload.finalMessage
                    };
                case 'error': {
                    var step = {
                        id: 'error-' + Date.now(),
                        type: 'failed',
                        title: 'Error',
                        detail: payload.message,
                        status: 'error',
                        timestamp: Date.now()
                    };
                    return {
                        ...state,
                        phase: 'error',
                        steps: state.steps.concat([step])
                    };
                }
                case 'clear':
                    return createInitialState();
                default:
                    return state;
            }
        }

        function formatDiffToLines(oldText, newText) {
            var oldLines = oldText.split('\\n');
            var newLines = newText.split('\\n');

            if (oldText === newText) {
                return oldLines.map(function(text, index) {
                    return { type: 'context', text: text, oldNum: index + 1, newNum: index + 1 };
                });
            }

            var firstDiff = -1;
            var lastDiff = -1;
            var maxLen = Math.max(oldLines.length, newLines.length);

            for (var i = 0; i < maxLen; i++) {
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

            var start = Math.max(0, firstDiff - 2);
            var end = Math.min(maxLen - 1, lastDiff + 2);

            var result = [];
            var oldNum = start + 1;
            var newNum = start + 1;

            for (var i = start; i <= end; i++) {
                var oldLine = oldLines[i];
                var newLine = newLines[i];
                var hasOld = i < oldLines.length;
                var hasNew = i < newLines.length;

                if (hasOld && hasNew && oldLine === newLine) {
                    result.push({ type: 'context', text: oldLine, oldNum: oldNum, newNum: newNum });
                    oldNum++;
                    newNum++;
                } else if (hasOld && hasNew && oldLine !== newLine) {
                    result.push({ type: 'remove', text: oldLine, oldNum: oldNum });
                    oldNum++;
                    result.push({ type: 'add', text: newLine, newNum: newNum });
                    newNum++;
                } else if (hasOld && !hasNew) {
                    result.push({ type: 'remove', text: oldLine, oldNum: oldNum });
                    oldNum++;
                } else if (!hasOld && hasNew) {
                    result.push({ type: 'add', text: newLine, newNum: newNum });
                    newNum++;
                }
            }

            return result;
        }

        function computeChangeSummary(oldText, newText) {
            var oldLines = oldText === '' ? [] : oldText.split('\\n');
            var newLines = newText === '' ? [] : newText.split('\\n');
            var maxLen = Math.max(oldLines.length, newLines.length);

            var additions = 0;
            var deletions = 0;

            for (var i = 0; i < maxLen; i++) {
                var hasOld = i < oldLines.length;
                var hasNew = i < newLines.length;

                if (hasOld && hasNew && oldLines[i] !== newLines[i]) {
                    additions++;
                    deletions++;
                } else if (!hasOld && hasNew) {
                    additions++;
                } else if (hasOld && !hasNew) {
                    deletions++;
                }
            }

            return additions + ' addition' + (additions === 1 ? '' : 's') + ', ' + deletions + ' deletion' + (deletions === 1 ? '' : 's');
        }

        var sessionState = createInitialState();

        function renderBackendBadge(state) {
            if (!els.backendBadge) return;
            if (state.backend) {
                els.backendBadge.classList.remove('hidden');
                els.backendBadge.innerHTML = '<span class="backend-badge">' + escapeHtml(state.backend) + '<span class="mode">' + escapeHtml(state.mode) + '</span></span>';
            } else {
                els.backendBadge.classList.add('hidden');
                els.backendBadge.innerHTML = '';
            }
        }

        function renderDegradedBanner(state) {
            if (!els.degradedBanner) return;
            if (state.degraded) {
                els.degradedBanner.classList.remove('hidden');
                els.degradedBanner.innerHTML = '<div class="degraded-banner">Running in compatibility mode. Server mode is recommended for the best experience.</div>';
            } else {
                els.degradedBanner.classList.add('hidden');
                els.degradedBanner.innerHTML = '';
            }
        }

        function renderPhaseIndicator(state) {
            if (!els.phaseIndicator) return;
            if (state.phase && state.phase !== 'idle') {
                els.phaseIndicator.classList.remove('hidden');
                var isFinished = state.phase === 'completed' || state.phase === 'failed' || state.phase === 'error';
                var spinnerHtml = isFinished ? '' : '<div class="spinner"></div>';
                var extraClass = isFinished ? (state.phase === 'completed' ? ' completed' : ' error') : '';
                els.phaseIndicator.innerHTML = '<div class="phase-indicator' + extraClass + '">' + spinnerHtml + '<div><div style="font-weight:500;">' + escapeHtml(state.phase) + '</div>' + (state.phaseMessage ? '<div style="font-size:11px;opacity:0.7;margin-top:2px;">' + escapeHtml(state.phaseMessage) + '</div>' : '') + '</div></div>';
            } else {
                els.phaseIndicator.classList.add('hidden');
                els.phaseIndicator.innerHTML = '';
            }
        }

        function renderTimeline(state) {
            if (!els.timeline) return;
            if (state.steps.length > 0) {
                els.timeline.classList.remove('hidden');
                var html = '<div class="timeline">';
                state.steps.forEach(function(step) {
                    var statusClass = step.status;
                    var icon = '○';
                    if (step.status === 'running') icon = '●';
                    else if (step.status === 'success') icon = '✓';
                    else if (step.status === 'error') icon = '✗';
                    html += '<div class="timeline-step ' + statusClass + '">';
                    html += '<div class="step-icon">' + icon + '</div>';
                    html += '<div class="step-body">';
                    html += '<div class="step-title">' + escapeHtml(step.title) + '</div>';
                    if (step.detail) {
                        html += '<div class="step-detail">' + escapeHtml(step.detail) + '</div>';
                    }
                    html += '</div></div>';
                });
                html += '</div>';
                els.timeline.innerHTML = html;
            } else {
                els.timeline.classList.add('hidden');
                els.timeline.innerHTML = '';
            }
        }

        function renderDiffCards(state) {
            if (!els.diffCards) return;
            if (state.diffCards.length > 0) {
                els.diffCards.classList.remove('hidden');
                var html = '<div class="diff-cards">';
                state.diffCards.forEach(function(card) {
                    var lines = formatDiffToLines(card.oldText, card.newText);
                    html += '<div class="diff-card">';
                    html += '<div class="diff-card-header">';
                    html += '<span>' + escapeHtml(card.path.split('/').pop() || card.path) + '</span>';
                    html += '<span class="diff-card-summary">' + escapeHtml(card.changeSummary) + '</span>';
                    html += '</div>';
                    html += '<div class="diff-card-body">';
                    lines.forEach(function(line) {
                        var lineClass = 'diff-line ' + line.type;
                        var numHtml = '';
                        if (line.type === 'context') {
                            numHtml = '<span class="line-num">' + line.oldNum + '</span>';
                        } else if (line.type === 'add') {
                            numHtml = '<span class="line-num">' + (line.newNum || '') + '</span>';
                        } else if (line.type === 'remove') {
                            numHtml = '<span class="line-num">' + (line.oldNum || '') + '</span>';
                        }
                        html += '<div class="' + lineClass + '">' + numHtml + escapeHtml(line.text) + '</div>';
                    });
                    html += '</div></div>';
                });
                html += '</div>';
                els.diffCards.innerHTML = html;
            } else {
                els.diffCards.classList.add('hidden');
                els.diffCards.innerHTML = '';
            }
        }

        function renderSessionResult(state) {
            if (!els.sessionResult) return;
            if (state.completed) {
                els.sessionResult.classList.remove('hidden');
                var resultClass = '';
                var title = '';
                if (state.success === true) {
                    resultClass = 'success';
                    title = 'Fix Applied';
                } else if (state.success === false) {
                    resultClass = 'failed';
                    title = 'Fix Failed';
                } else {
                    resultClass = 'cancelled';
                    title = 'Fix Cancelled';
                }
                els.sessionResult.innerHTML = '<div class="session-result ' + resultClass + '"><div style="font-weight:600;margin-bottom:4px;">' + title + '</div><div>' + escapeHtml(state.finalMessage) + '</div></div>';
            } else {
                els.sessionResult.classList.add('hidden');
                els.sessionResult.innerHTML = '';
            }
        }

        function renderAll() {
            renderBackendBadge(sessionState);
            renderDegradedBanner(sessionState);
            renderPhaseIndicator(sessionState);
            renderTimeline(sessionState);
            renderDiffCards(sessionState);
            renderSessionResult(sessionState);
        }

        window.addEventListener("message", function(event) {
            var msg = event.data;
            log("Received: " + msg.type);

            sessionState = reduceSessionState(sessionState, msg);
            renderAll();

            if (msg.type === "clear") {
                if (container) container.innerHTML = "";
                messageMap.clear();
                toolCallMap.clear();
                if (els.stopBtn) {
                    els.stopBtn.classList.add("hidden");
                    els.stopBtn.disabled = false;
                    els.stopBtn.textContent = "Pause";
                }
                if (els.cancelBtn) {
                    els.cancelBtn.classList.add("hidden");
                    els.cancelBtn.disabled = false;
                    els.cancelBtn.textContent = "Cancel";
                }
            } else if (msg.type === "text_stream") {
                appendText(msg.payload.messageId, msg.payload.delta);
            } else if (msg.type === "tool_call") {
                appendToolCall(msg.payload);
            } else if (msg.type === "tool_result") {
                appendToolResult(msg.payload);
            } else if (msg.type === "diff") {
                appendDiff(msg.payload);
            } else if (msg.type === "final_diff") {
                appendFinalDiff(msg.payload);
            } else if (msg.type === "message_complete") {
                completeMessage(msg.payload.messageId);
            } else if (msg.type === "error") {
                showError(msg.payload.message);
            } else if (msg.type === "queue_state") {
                renderQueueState(msg.payload);
            }
        });

        if (els.stopBtn) {
            els.stopBtn.addEventListener("click", function() {
                vscode.postMessage({ type: "pause_toggle" });
            });
        }
        if (els.cancelBtn) {
            els.cancelBtn.addEventListener("click", function() {
                els.cancelBtn.disabled = true;
                vscode.postMessage({ type: "cancel_current" });
            });
        }
        if (els.queueHeader) {
            els.queueHeader.addEventListener("click", function() {
                queueExpanded = !queueExpanded;
                if (els.queueBody) {
                    if (queueExpanded) els.queueBody.classList.remove("hidden");
                    else els.queueBody.classList.add("hidden");
                }
                els.queueHeader.textContent = (queueExpanded ? "▼ " : "▶ ") + lastQueueHeaderBody;
            });
        }

        function appendText(messageId, delta) {
            log("appendText: " + messageId);
            var el = messageMap.get(messageId);
            if (!el) {
                el = document.createElement("div");
                el.className = "message assistant";
                var header = document.createElement("div");
                header.className = "message-header";
                header.textContent = "Assistant";
                el.appendChild(header);
                var content = document.createElement("div");
                content.className = "content streaming-cursor";
                el.appendChild(content);
                if (container) container.appendChild(el);
                messageMap.set(messageId, el);
            }
            var content = el.querySelector(".content");
            if (content) {
                content.textContent += delta;
                if (container) container.scrollTop = container.scrollHeight;
            }
        }

        function completeMessage(messageId) {
            var el = messageMap.get(messageId);
            if (el) {
                var content = el.querySelector(".content");
                if (content) content.classList.remove("streaming-cursor");
            }
        }

        function showError(message) {
            var el = document.createElement("div");
            el.style.padding = "12px";
            el.style.background = "rgba(244,67,54,0.1)";
            el.style.borderLeft = "3px solid #f44336";
            el.style.borderRadius = "4px";
            el.style.color = "#f44336";
            el.textContent = "Error: " + message;
            if (container) container.appendChild(el);
        }

        function renderQueueState(payload) {
            if (!els.queuePanel || !els.queueHeader || !els.queueBody) return;
            var items = payload.items || [];
            var n = items.length;
            var sessionPaused = Boolean(payload.paused);
            if (n > 0) {
                els.queuePanel.classList.remove("hidden");
                queueExpanded = true;
                els.queueBody.classList.remove("hidden");
                lastQueueHeaderBody = sessionPaused
                    ? ("Paused · " + n + " queued")
                    : (n + " problem" + (n === 1 ? "" : "s") + " queued");
                els.queueHeader.textContent = "▼ " + lastQueueHeaderBody;
                els.queueBody.innerHTML = "";
                items.forEach(function(item) {
                    var row = document.createElement("div");
                    row.className = "queue-item";
                    var text = document.createElement("span");
                    text.textContent = item.title;
                    row.appendChild(text);
                    var removeBtn = document.createElement("button");
                    removeBtn.className = "queue-remove";
                    removeBtn.textContent = "🗑";
                    removeBtn.addEventListener("click", function(e) {
                        e.stopPropagation();
                        vscode.postMessage({ type: "remove_queued", id: item.id });
                    });
                    row.appendChild(removeBtn);
                    els.queueBody.appendChild(row);
                });
            } else {
                els.queuePanel.classList.add("hidden");
                queueExpanded = false;
                els.queueBody.classList.add("hidden");
                els.queueBody.innerHTML = "";
                lastQueueHeaderBody = "0 problems queued";
                els.queueHeader.textContent = "▶ " + lastQueueHeaderBody;
            }
            if (els.stopBtn) {
                if (payload.hasPendingTasks) {
                    els.stopBtn.classList.remove("hidden");
                    els.stopBtn.disabled = false;
                    els.stopBtn.textContent = payload.paused ? "Resume" : "Pause";
                } else {
                    els.stopBtn.classList.add("hidden");
                }
            }
            if (els.cancelBtn) {
                if (payload.hasPendingTasks) {
                    els.cancelBtn.classList.remove("hidden");
                    els.cancelBtn.disabled = false;
                    els.cancelBtn.textContent = n > 0 ? "Skip" : "Cancel";
                } else {
                    els.cancelBtn.classList.add("hidden");
                }
            }
        }

        function appendToolCall(payload) {
            log("appendToolCall: " + payload.name);
            var el = document.createElement("div");
            el.className = "message tool";
            var header = document.createElement("div");
            header.className = "message-header";
            header.textContent = "Tool Call: " + payload.name;
            el.appendChild(header);
            var params = document.createElement("pre");
            params.style.margin = "8px 0";
            params.style.padding = "8px";
            params.style.background = "rgba(0,0,0,0.2)";
            params.style.borderRadius = "4px";
            params.style.overflow = "auto";
            params.style.fontSize = "12px";
            params.textContent = JSON.stringify(payload.params, null, 2);
            el.appendChild(params);
            if (container) container.appendChild(el);
            toolCallMap.set(payload.toolCallId, el);
        }

        function appendToolResult(payload) {
            log("appendToolResult: " + payload.toolCallId);
            var el = toolCallMap.get(payload.toolCallId);
            if (el) {
                var result = document.createElement("div");
                result.style.marginTop = "8px";
                result.style.padding = "8px";
                result.style.background = payload.isError ? "rgba(244,67,54,0.1)" : "rgba(76,175,80,0.1)";
                result.style.borderRadius = "4px";
                result.style.fontSize = "12px";
                result.style.maxHeight = "200px";
                result.style.overflow = "auto";
                result.style.color = payload.isError ? "#f44336" : "#4caf50";
                result.textContent = payload.result.substring(0, 500) + (payload.result.length > 500 ? "..." : "");
                el.appendChild(result);
            }
        }

        function appendDiff(payload) {
            log("appendDiff: " + payload.path);
            var el = document.createElement("div");
            el.className = "message diff";
            var header = document.createElement("div");
            header.className = "message-header";
            header.textContent = "Diff: " + (payload.path.split("/").pop() || payload.path);
            el.appendChild(header);
            var diffContent = document.createElement("div");
            diffContent.style.marginTop = "8px";
            diffContent.style.padding = "12px";
            diffContent.style.background = "rgba(0,0,0,0.2)";
            diffContent.style.borderRadius = "4px";
            diffContent.style.fontFamily = "monospace";
            diffContent.style.fontSize = "12px";
            diffContent.style.whiteSpace = "pre";
            diffContent.style.overflow = "auto";
            diffContent.style.maxHeight = "300px";
            var oldLines = (payload.oldText || "").split("\\n");
            var newLines = (payload.newText || "").split("\\n");
            var maxLines = Math.max(oldLines.length, newLines.length);
            var diffText = "";
            for (var i = 0; i < maxLines; i++) {
                var oldLine = oldLines[i] || "";
                var newLine = newLines[i] || "";
                if (oldLine !== newLine) {
                    if (oldLine) diffText += "- " + oldLine + "\\n";
                    if (newLine) diffText += "+ " + newLine + "\\n";
                }
            }
            diffContent.textContent = diffText || "(no changes)";
            el.appendChild(diffContent);
            if (container) container.appendChild(el);
        }

        function appendFinalDiff(payload) {
            log("appendFinalDiff: " + payload.path);
            var separator = document.createElement("div");
            separator.style.marginTop = "24px";
            separator.style.paddingTop = "16px";
            separator.style.borderTop = "2px solid #4caf50";
            separator.innerHTML = '<div style="color: #4caf50; font-weight: bold; margin-bottom: 8px;">✓ Fix Applied</div><div style="opacity: 0.7; font-size: 12px;">File: ' + (payload.path.split("/").pop() || payload.path) + '</div>';
            if (container) container.appendChild(separator);

            var el = document.createElement("div");
            el.className = "message diff";
            el.style.marginTop = "16px";

            var oldContent = payload.oldContent || "";
            var newContent = payload.newContent || "";

            if (oldContent === newContent) {
                el.innerHTML = '<div style="padding: 12px; opacity: 0.7;">No changes were made to the file.</div>';
            } else {
                var table = document.createElement("table");
                table.style.width = "100%";
                table.style.borderCollapse = "collapse";
                table.style.fontSize = "12px";
                table.style.fontFamily = "monospace";

                var oldLines = oldContent.split("\\n");
                var newLines = newContent.split("\\n");
                var changes = [];

                for (var i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
                    var oldLine = oldLines[i] || "";
                    var newLine = newLines[i] || "";
                    if (oldLine !== newLine) {
                        changes.push(i);
                    }
                }

                var showLines = new Set();
                changes.forEach(function(changeIdx) {
                    for (var i = Math.max(0, changeIdx - 2); i <= Math.min(Math.max(oldLines.length, newLines.length) - 1, changeIdx + 2); i++) {
                        showLines.add(i);
                    }
                });

                var sortedLines = Array.from(showLines).sort(function(a, b) { return a - b; });

                sortedLines.forEach(function(lineIdx) {
                    var oldLine = oldLines[lineIdx] || "";
                    var newLine = newLines[lineIdx] || "";
                    var isChanged = oldLine !== newLine;

                    var row = table.insertRow();

                    var oldCell = row.insertCell();
                    oldCell.style.padding = "4px 8px";
                    oldCell.style.borderBottom = "1px solid #3c3c3c";
                    oldCell.style.verticalAlign = "top";
                    oldCell.style.background = isChanged ? "rgba(255, 0, 0, 0.1)" : "transparent";
                    oldCell.style.textDecoration = isChanged && oldLine ? "line-through" : "none";
                    oldCell.style.color = isChanged ? "#f44336" : "#d4d4d4";
                    oldCell.innerHTML = '<span style="opacity: 0.5">' + (lineIdx + 1) + '</span> ' + escapeHtml(oldLine);

                    var newCell = row.insertCell();
                    newCell.style.padding = "4px 8px";
                    newCell.style.borderBottom = "1px solid #3c3c3c";
                    newCell.style.verticalAlign = "top";
                    newCell.style.background = isChanged ? "rgba(0, 255, 0, 0.1)" : "transparent";
                    newCell.style.color = isChanged ? "#4caf50" : "#d4d4d4";
                    newCell.innerHTML = '<span style="opacity: 0.5">' + (lineIdx + 1) + '</span> ' + escapeHtml(newLine);
                });

                el.appendChild(table);
            }

            if (container) container.appendChild(el);
        }

        function escapeHtml(str) {
            return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        }

        log("Ready");
        vscode.postMessage({ type: "fix_details_ready" });
`;
