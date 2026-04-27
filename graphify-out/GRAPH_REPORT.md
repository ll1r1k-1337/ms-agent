# Graph Report - .  (2026-04-27)

## Corpus Check
- 51 files · ~54,509 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 564 nodes · 907 edges · 89 communities detected
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 129 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]

## God Nodes (most connected - your core abstractions)
1. `AcpTransport` - 41 edges
2. `ServeTransport` - 32 edges
3. `isRecordLike()` - 23 edges
4. `msAgent` - 19 edges
5. `handleMessage()` - 17 edges
6. `DiagnosticsManager` - 17 edges
7. `MockTransport` - 13 edges
8. `FixtureTransport` - 12 edges
9. `extractToolCall()` - 12 edges
10. `WebviewPanelProvider` - 11 edges

## Surprising Connections (you probably didn't know these)
- `msAgent` --conceptually_related_to--> `raw/服务器 | OpenCode.pdf`  [AMBIGUOUS]
  README.md → raw/服务器 | OpenCode.pdf
- `basename()` --calls--> `getDiagnosticTitle()`  [INFERRED]
  media/fixPanel.js → src/vscode/fixService.ts
- `runLocalFix()` --calls--> `parseModelName()`  [INFERRED]
  test/integration/localOpencode.integration.test.ts → src/llm/configResolver.ts
- `msAgent` --integrates_with--> `mstt (OP DevTools)`  [EXTRACTED]
  README.md → docs/MSTT_INTEGRATION_ARCHITECTURE.md
- `msAgent` --guides--> `docs/SOURCE_GUIDE.md`  [EXTRACTED]
  README.md → docs/SOURCE_GUIDE.md

## Hyperedges (group relationships)
- **Agent Loop Execution Pipeline** — agentLoop_runAgent, agentLoop_handleStreamingLLM, agentLoop_waitWhilePaused, agentLoop_AgentRunAbortedError [INFERRED 0.85]
- **Log Parser Processing Pipeline** — logParser_parseLogFile, logParser_parseLog, logParser_groupLines, logParser_parseGroup, logParser_parseLeakOrUnused, logParser_classifyError [INFERRED 0.85]
- **Parser Type System** — parser_types_MemErrorType, parser_types_AddressSpace, parser_types_BlockType, parser_types_Severity, parser_types_SanitizerDiagnostic, parser_types_ParseResult, parser_types_ThreadLocation, parser_types_StackFrame, parser_types_BlockInfo [INFERRED 0.80]
- **Agent Loop Test Suite** — agentLoop_test, agentLoop_runAgent, agentLoop_AgentRunAbortedError [INFERRED 0.80]
- **Log Parser Test Suite** — logParser_test, logParser_parseLogFile, logParser_parseLog [INFERRED 0.80]
- **** — opencode_session, session_state_machine, disposable_store [EXTRACTED 1.00]
- **** — session_state_machine, session_events, opencode_event_adapter [EXTRACTED 1.00]
- **** — session_state_reducer, session_state_machine, webview_messages [INFERRED 0.80]
- **Webview Message Protocol Participants** — messages_webview_protocol, webview_panel_provider, session_state_reducer, session_state_test [EXTRACTED 1.00]
- **Session State Management** — session_state_reducer, session_state_test, fix_details_script_test, reduce_session_state, format_diff_to_lines, compute_change_summary, phase_to_timeline_type [EXTRACTED 1.00]
- **Webview Rendering Pipeline** — webview_panel_provider, fix_details_script_bundle, fix_details_script_test [INFERRED 0.80]
- **Agent Loop Core Components** — agent_agentloop, agent_message, llm_provider, llm_openaicompat, tools_toolhandlers [INFERRED 0.85]
- **OpenCode Backend Implementation Stack** — backends_opencode, backends_transport, backends_session, backends_eventadapter [INFERRED 0.88]
- **Eight Supported Memory Error Types** — error_outofbounds, error_illegaladdrread, error_illegaladdrwrite, error_misalignedaccess, error_memleak, error_illegalfree, error_memunused, error_uninitializedread [EXTRACTED 1.00]
- **OpenCodeTransport interface implementations** — opencodeTransport_CliTransport, opencodeTransport_ServeTransport, opencodeTransport_ApiTransport, opencodeTransport_OpenCodeTransport [INFERRED 0.90]
- **OpenCodeEventAdapter public API surface** — opencodeEventAdapter_extractToolCall, opencodeEventAdapter_extractToolResult, opencodeEventAdapter_extractTextDelta, opencodeEventAdapter_extractErrorMessage, opencodeEventAdapter_isCompletionEvent [INFERRED 0.85]
- **Shared inactivity timeout pattern across transports** — opencodeTransport_CliTransport, opencodeTransport_ServeTransport [INFERRED 0.75]
- **WebView DOM Contract** — fixDetailsScript_script, webviewPanelProvider_WebviewPanelProvider, webviewPanelProvider_test_WebviewPanelProviderTest [INFERRED 0.75]
- **Settings Panel Test Suite** — settingsPanelProvider_SettingsPanelProvider, settingsPanelProvider_test_SettingsPanelProviderTest, openaiCompatProvider_OpenAICompatProvider [EXTRACTED 1.00]

## Communities

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (4): AcpTransport, isRecordLike(), _resetTestDeps(), ServeTransport

### Community 1 - "Community 1"
Cohesion: 0.09
Nodes (54): add_custom(), $(), appendDiff(), appendFinalDiff(), appendSessionResult(), appendTextStream(), appendToolCall(), appendToolResult() (+46 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (23): createFixBackend(), clearConversationIfCancelledAndIdle(), createFixRunId(), ensureFixDetailsPanel(), fixAllDiagnostics(), fixProblem(), fixSingleDiagnostic(), formatOpenCodeConnectionError() (+15 more)

### Community 3 - "Community 3"
Cohesion: 0.11
Nodes (18): buildFocusedSnippet(), buildOpenCodePrompt(), buildRetryPrompt(), buildTargetedRepairHint(), buildTransportConfig(), getLine(), getOutputChannel(), collectingCallbacks() (+10 more)

### Community 4 - "Community 4"
Cohesion: 0.21
Nodes (24): extractErrorMessage(), extractMessageId(), extractMessageRole(), extractPartMessageId(), extractSessionId(), extractTextDelta(), extractToolCall(), extractToolResult() (+16 more)

### Community 5 - "Community 5"
Cohesion: 0.08
Nodes (11): makeContext(), CancellationTokenSource, CodeAction, Diagnostic, DiagnosticRelatedInformation, EventEmitter, Location, Position (+3 more)

### Community 6 - "Community 6"
Cohesion: 0.1
Nodes (13): FixActionProvider, registerFixActions(), activate(), deactivate(), getWorkspaceRoots(), selectOpenCodeModel(), extractModelsFromOpenCodeConfig(), getConfigPathSpecs() (+5 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (20): Ollama, OpenAI-compatible API, msagent.modelEndpoint, docs/MSTT_INTEGRATION_ARCHITECTURE.md, docs/OPENCODE_AGENT_INTEGRATION_PLAN.md, docs/SOURCE_GUIDE.md, ILLEGAL_ADDR_READ, ILLEGAL_ADDR_WRITE (+12 more)

### Community 8 - "Community 8"
Cohesion: 0.09
Nodes (7): bodyOf(), MockChildProcess, MockClientRequest, MockIncomingMessage, MockWritable, respondWithJson(), SessionStateMachine

### Community 9 - "Community 9"
Cohesion: 0.14
Nodes (4): DiagnosticsManager, parseLogAtPathAndNotify(), resetAiFixHistory(), resolveFilePath()

### Community 10 - "Community 10"
Cohesion: 0.15
Nodes (10): createQueueTaskId(), ensureManagedServer(), getCliPath(), getServerKey(), probePort(), waitForServerReady(), wrapSpawnError(), clearConfig() (+2 more)

### Community 11 - "Community 11"
Cohesion: 0.18
Nodes (11): getLLMConfig(), normalizeArgs(), normalizeOpenCodeMode(), parseModelName(), resolveLLMConfig(), collectEvents(), makeDiagnostic(), makeWorkspace() (+3 more)

### Community 12 - "Community 12"
Cohesion: 0.15
Nodes (3): FixtureTransport, loadFixture(), wait()

### Community 13 - "Community 13"
Cohesion: 0.18
Nodes (7): classifyAssistantExplanation(), extractAssistantExplanationFromSessionMessages(), extractAssistantExplanationFromTextMap(), extractMessageSnapshotText(), hasStructuredExplanation(), looksLikeProcessNarration(), OpenCodeSession

### Community 14 - "Community 14"
Cohesion: 0.14
Nodes (1): MockTransport

### Community 15 - "Community 15"
Cohesion: 0.33
Nodes (12): classifyError(), extractInt(), extractStr(), groupLines(), isMemoryError(), parseAddressSpace(), parseBlockType(), parseFileSize() (+4 more)

### Community 16 - "Community 16"
Cohesion: 0.25
Nodes (0): 

### Community 17 - "Community 17"
Cohesion: 0.29
Nodes (1): DisposableStore

### Community 18 - "Community 18"
Cohesion: 0.53
Nodes (4): computeChangeSummary(), createInitialState(), phaseToTimelineType(), reduceSessionState()

### Community 19 - "Community 19"
Cohesion: 0.33
Nodes (6): Tool Dispatch, Rationale: Tool Dispatch design, edit_file, list_files, read_diagnostics, read_file

### Community 20 - "Community 20"
Cohesion: 0.4
Nodes (1): MockRange

### Community 21 - "Community 21"
Cohesion: 0.67
Nodes (0): 

### Community 22 - "Community 22"
Cohesion: 1.0
Nodes (3): docs/TEST_GUIDE.md, docs/TEST_PLAN.md, T1: Log Parser Test

### Community 23 - "Community 23"
Cohesion: 1.0
Nodes (0): 

### Community 24 - "Community 24"
Cohesion: 1.0
Nodes (0): 

### Community 25 - "Community 25"
Cohesion: 1.0
Nodes (0): 

### Community 26 - "Community 26"
Cohesion: 1.0
Nodes (2): Agent Loop, Rationale: Loop until done design

### Community 27 - "Community 27"
Cohesion: 1.0
Nodes (2): Skill Loading, Rationale: On-demand Skills design

### Community 28 - "Community 28"
Cohesion: 1.0
Nodes (2): Event Protocol, Rationale: Event-driven real-time updates

### Community 29 - "Community 29"
Cohesion: 1.0
Nodes (2): msagent.modelName, qwen3:8b

### Community 30 - "Community 30"
Cohesion: 1.0
Nodes (0): 

### Community 31 - "Community 31"
Cohesion: 1.0
Nodes (2): FixBackend Interface, Rationale: Backend-agnostic UI

### Community 32 - "Community 32"
Cohesion: 1.0
Nodes (2): Degradation Strategy, Rationale: Graceful degradation

### Community 33 - "Community 33"
Cohesion: 1.0
Nodes (0): 

### Community 34 - "Community 34"
Cohesion: 1.0
Nodes (0): 

### Community 35 - "Community 35"
Cohesion: 1.0
Nodes (0): 

### Community 36 - "Community 36"
Cohesion: 1.0
Nodes (0): 

### Community 37 - "Community 37"
Cohesion: 1.0
Nodes (0): 

### Community 38 - "Community 38"
Cohesion: 1.0
Nodes (0): 

### Community 39 - "Community 39"
Cohesion: 1.0
Nodes (0): 

### Community 40 - "Community 40"
Cohesion: 1.0
Nodes (0): 

### Community 41 - "Community 41"
Cohesion: 1.0
Nodes (0): 

### Community 42 - "Community 42"
Cohesion: 1.0
Nodes (0): 

### Community 43 - "Community 43"
Cohesion: 1.0
Nodes (0): 

### Community 44 - "Community 44"
Cohesion: 1.0
Nodes (0): 

### Community 45 - "Community 45"
Cohesion: 1.0
Nodes (0): 

### Community 46 - "Community 46"
Cohesion: 1.0
Nodes (0): 

### Community 47 - "Community 47"
Cohesion: 1.0
Nodes (0): 

### Community 48 - "Community 48"
Cohesion: 1.0
Nodes (0): 

### Community 49 - "Community 49"
Cohesion: 1.0
Nodes (0): 

### Community 50 - "Community 50"
Cohesion: 1.0
Nodes (1): skills/memcheck-skills.md

### Community 51 - "Community 51"
Cohesion: 1.0
Nodes (1): Streaming WebView

### Community 52 - "Community 52"
Cohesion: 1.0
Nodes (1): CodeAction Quick Fix

### Community 53 - "Community 53"
Cohesion: 1.0
Nodes (1): Diagnostics Manager

### Community 54 - "Community 54"
Cohesion: 1.0
Nodes (1): Fix Service

### Community 55 - "Community 55"
Cohesion: 1.0
Nodes (1): LLM Provider

### Community 56 - "Community 56"
Cohesion: 1.0
Nodes (1): Cancellation Token

### Community 57 - "Community 57"
Cohesion: 1.0
Nodes (1): Progress Notification

### Community 58 - "Community 58"
Cohesion: 1.0
Nodes (1): Content Security Policy (CSP)

### Community 59 - "Community 59"
Cohesion: 1.0
Nodes (1): Diff Rendering

### Community 60 - "Community 60"
Cohesion: 1.0
Nodes (1): Transport Layer

### Community 61 - "Community 61"
Cohesion: 1.0
Nodes (1): OpenCodeSession

### Community 62 - "Community 62"
Cohesion: 1.0
Nodes (1): Event Adapter

### Community 63 - "Community 63"
Cohesion: 1.0
Nodes (1): Message Replay

### Community 64 - "Community 64"
Cohesion: 1.0
Nodes (1): Queue State Management

### Community 65 - "Community 65"
Cohesion: 1.0
Nodes (1): msagent.temperature

### Community 66 - "Community 66"
Cohesion: 1.0
Nodes (1): msagent.maxTokens

### Community 67 - "Community 67"
Cohesion: 1.0
Nodes (1): msagent.timeoutMs

### Community 68 - "Community 68"
Cohesion: 1.0
Nodes (1): msagent.provider

### Community 69 - "Community 69"
Cohesion: 1.0
Nodes (1): msagent.opencodeMode

### Community 70 - "Community 70"
Cohesion: 1.0
Nodes (1): msagent.opencodeCliPath

### Community 71 - "Community 71"
Cohesion: 1.0
Nodes (1): msagent.opencodeServePort

### Community 72 - "Community 72"
Cohesion: 1.0
Nodes (1): msagent.opencodeApiEndpoint

### Community 73 - "Community 73"
Cohesion: 1.0
Nodes (1): msagent.opencodeApiKey

### Community 74 - "Community 74"
Cohesion: 1.0
Nodes (1): T2: LLM Communication Test

### Community 75 - "Community 75"
Cohesion: 1.0
Nodes (1): T3: LLM Tool Call Generation Test

### Community 76 - "Community 76"
Cohesion: 1.0
Nodes (1): T4: Agent Loop Test (Mock LLM)

### Community 77 - "Community 77"
Cohesion: 1.0
Nodes (1): T5: Full E2E Fix Test

### Community 78 - "Community 78"
Cohesion: 1.0
Nodes (1): T6: Error Recovery Test

### Community 79 - "Community 79"
Cohesion: 1.0
Nodes (1): vLLM

### Community 80 - "Community 80"
Cohesion: 1.0
Nodes (1): llama.cpp server

### Community 81 - "Community 81"
Cohesion: 1.0
Nodes (1): xinference

### Community 82 - "Community 82"
Cohesion: 1.0
Nodes (1): qwen3-coder:30b

### Community 83 - "Community 83"
Cohesion: 1.0
Nodes (1): qwen2.5:3b

### Community 84 - "Community 84"
Cohesion: 1.0
Nodes (1): deepseek-coder:6.7b

### Community 85 - "Community 85"
Cohesion: 1.0
Nodes (1): Rationale: Error Recovery design

### Community 86 - "Community 86"
Cohesion: 1.0
Nodes (1): Rationale: Message History Management

### Community 87 - "Community 87"
Cohesion: 1.0
Nodes (1): Rationale: WebView Rendering optimization

### Community 88 - "Community 88"
Cohesion: 1.0
Nodes (1): Rationale: LLM Streaming UX

## Ambiguous Edges - Review These
- `msAgent` → `raw/服务器 | OpenCode.pdf`  [AMBIGUOUS]
  raw/服务器 | OpenCode.pdf · relation: conceptually_related_to

## Knowledge Gaps
- **72 isolated node(s):** `msSanitizer`, `skills/memcheck-skills.md`, `Agent Loop`, `Streaming WebView`, `CodeAction Quick Fix` (+67 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 23`** (2 nodes): `makeReader()`, `config.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 24`** (2 nodes): `makeDiag()`, `diagnosticsManager.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 25`** (2 nodes): `makeDiag()`, `fixService.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 26`** (2 nodes): `Agent Loop`, `Rationale: Loop until done design`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 27`** (2 nodes): `Skill Loading`, `Rationale: On-demand Skills design`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 28`** (2 nodes): `Event Protocol`, `Rationale: Event-driven real-time updates`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 29`** (2 nodes): `msagent.modelName`, `qwen3:8b`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 30`** (2 nodes): `AGENTS.md`, `CLAUDE.md`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 31`** (2 nodes): `FixBackend Interface`, `Rationale: Backend-agnostic UI`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 32`** (2 nodes): `Degradation Strategy`, `Rationale: Graceful degradation`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 33`** (1 nodes): `setup.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 34`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 35`** (1 nodes): `opencodeModelCatalog.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 36`** (1 nodes): `openCodeFixBackend.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 37`** (1 nodes): `fixBackend.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 38`** (1 nodes): `backendFactory.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 39`** (1 nodes): `opencodeEventAdapter.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 40`** (1 nodes): `messages.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 41`** (1 nodes): `fixDetailsScript.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 42`** (1 nodes): `sessionState.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (1 nodes): `fixDetailsScript.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (1 nodes): `webviewPanelProvider.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (1 nodes): `sessionEvents.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 46`** (1 nodes): `sessionStateMachine.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 47`** (1 nodes): `logParser.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (1 nodes): `types.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 49`** (1 nodes): `skillLoader.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 50`** (1 nodes): `skills/memcheck-skills.md`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 51`** (1 nodes): `Streaming WebView`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 52`** (1 nodes): `CodeAction Quick Fix`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 53`** (1 nodes): `Diagnostics Manager`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 54`** (1 nodes): `Fix Service`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 55`** (1 nodes): `LLM Provider`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 56`** (1 nodes): `Cancellation Token`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 57`** (1 nodes): `Progress Notification`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 58`** (1 nodes): `Content Security Policy (CSP)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 59`** (1 nodes): `Diff Rendering`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 60`** (1 nodes): `Transport Layer`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 61`** (1 nodes): `OpenCodeSession`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 62`** (1 nodes): `Event Adapter`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 63`** (1 nodes): `Message Replay`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 64`** (1 nodes): `Queue State Management`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 65`** (1 nodes): `msagent.temperature`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 66`** (1 nodes): `msagent.maxTokens`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 67`** (1 nodes): `msagent.timeoutMs`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 68`** (1 nodes): `msagent.provider`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 69`** (1 nodes): `msagent.opencodeMode`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 70`** (1 nodes): `msagent.opencodeCliPath`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 71`** (1 nodes): `msagent.opencodeServePort`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 72`** (1 nodes): `msagent.opencodeApiEndpoint`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 73`** (1 nodes): `msagent.opencodeApiKey`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 74`** (1 nodes): `T2: LLM Communication Test`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 75`** (1 nodes): `T3: LLM Tool Call Generation Test`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 76`** (1 nodes): `T4: Agent Loop Test (Mock LLM)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 77`** (1 nodes): `T5: Full E2E Fix Test`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 78`** (1 nodes): `T6: Error Recovery Test`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 79`** (1 nodes): `vLLM`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 80`** (1 nodes): `llama.cpp server`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 81`** (1 nodes): `xinference`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 82`** (1 nodes): `qwen3-coder:30b`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 83`** (1 nodes): `qwen2.5:3b`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 84`** (1 nodes): `deepseek-coder:6.7b`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 85`** (1 nodes): `Rationale: Error Recovery design`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 86`** (1 nodes): `Rationale: Message History Management`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 87`** (1 nodes): `Rationale: WebView Rendering optimization`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 88`** (1 nodes): `Rationale: LLM Streaming UX`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `msAgent` and `raw/服务器 | OpenCode.pdf`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `AcpTransport` connect `Community 0` to `Community 1`, `Community 10`?**
  _High betweenness centrality (0.090) - this node is a cross-community bridge._
- **Why does `ServeTransport` connect `Community 0` to `Community 10`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **Why does `loadFixture()` connect `Community 12` to `Community 3`, `Community 4`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **What connects `msSanitizer`, `skills/memcheck-skills.md`, `Agent Loop` to the rest of the system?**
  _72 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._