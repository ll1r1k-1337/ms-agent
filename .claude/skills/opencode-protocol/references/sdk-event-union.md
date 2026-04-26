# SDK Event Union — @opencode-ai/sdk@1.3.2

Authoritative discriminator list extracted on 2026-04-26 from
`@opencode-ai/sdk@1.3.2/dist/gen/types.gen.d.ts`. The SDK is generated from
opencode's internal schema, so this is the closest thing to a canonical
event catalog. The OpenAPI document at `GET /doc` is **not** equivalent —
it only lists 2 of the 19+ real paths.

Re-extract with:

```sh
SDK=$(npm root -g)/@opencode-ai/sdk/dist/gen     # or your install path
awk '/^export type Event[A-Z]/ {n=$3; f=1; next} f && /type:/ {print n,$0; f=0}' \
  $SDK/types.gen.d.ts
```

## Event Discriminator Map

| TypeScript symbol | `type` discriminator |
|---|---|
| EventServerConnected | `server.connected` |
| EventServerInstanceDisposed | `server.instance.disposed` |
| EventInstallationUpdated | `installation.updated` |
| EventInstallationUpdateAvailable | `installation.update-available` |
| EventLspClientDiagnostics | `lsp.client.diagnostics` |
| EventLspUpdated | `lsp.updated` |
| EventMessageUpdated | `message.updated` |
| EventMessageRemoved | `message.removed` |
| EventMessagePartUpdated | `message.part.updated` |
| EventMessagePartRemoved | `message.part.removed` |
| EventPermissionUpdated | `permission.updated` |
| EventPermissionReplied | `permission.replied` |
| EventSessionStatus | `session.status` |
| EventSessionIdle | `session.idle` |
| EventSessionCompacted | `session.compacted` |
| EventSessionCreated | `session.created` |
| EventSessionUpdated | `session.updated` |
| EventSessionDeleted | `session.deleted` |
| EventSessionDiff | `session.diff` |
| EventSessionError | `session.error` |
| EventFileEdited | `file.edited` |
| EventFileWatcherUpdated | `file.watcher.updated` |
| EventTodoUpdated | `todo.updated` |
| EventCommandExecuted | `command.executed` |
| EventVcsBranchUpdated | `vcs.branch.updated` |
| EventTuiPromptAppend | `tui.prompt.append` |
| EventTuiCommandExecute | `tui.command.execute` |
| EventTuiToastShow | `tui.toast.show` |
| EventPtyCreated | `pty.created` |
| EventPtyUpdated | `pty.updated` |
| EventPtyExited | `pty.exited` |
| EventPtyDeleted | `pty.deleted` |

32 documented events.

## Undocumented but Real

| `type` | Source of truth | Notes |
|---|---|---|
| `server.heartbeat` | `events/captured-prompt-cycle.sse.txt` (events 18–21) | Keep-alive ping. Not in SDK union. Fires every few seconds, indefinitely, after any activity. Adapter must default-ignore. |

The adapter MUST tolerate unknown `type` values: log at debug level, do not
throw, do not treat as terminal.

## Critical Schemas

### EventMessageUpdated  (the terminal carrier — see SKILL.md R2)

```ts
{
  type: "message.updated";
  properties: {
    info: Message;     // UserMessage | AssistantMessage
  };
}
```

`AssistantMessage.time.completed` is the **only** authoritative completion
signal. `AssistantMessage.error` populates on failure. `AssistantMessage.finish`
populates on success (string reason like `"stop"`).

### EventMessagePartUpdated  (the streaming delta carrier)

```ts
{
  type: "message.part.updated";
  properties: {
    part: Part;        // 11 variants — see SKILL.md Part Catalog
    delta?: string;    // present for text streaming
  };
}
```

Same `part.id` is updated repeatedly; consumer must merge by id.

### EventSessionIdle  (NOT a terminal signal)

```ts
{
  type: "session.idle";
  properties: { sessionID: string };
}
```

Fires after success, after error, after abort. Can fire multiple times.
Treating this as "done" is the original soft-close bug.

### EventSessionError  (carries provider-level failures)

```ts
{
  type: "session.error";
  properties: {
    sessionID?: string;
    error?: ProviderAuthError | UnknownError | MessageOutputLengthError
          | MessageAbortedError | ApiError;
  };
}
```

The same error is also embedded in the next `message.updated` with the
assistant message. Consumer can rely on the message-level error and ignore
this event for terminal logic.

### EventSessionDiff  (NOT a terminal signal)

```ts
{
  type: "session.diff";
  properties: {
    sessionID: string;
    diff: Array<FileDiff>;   // FileDiff = {file, before, after, additions, deletions}
  };
}
```

Can fire with `diff: []` even when nothing changed. Inspect the array
contents, do not infer from the event's mere presence.

### SessionStatus  (status discriminator)

```ts
type SessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy" };
```

`retry` is interesting: opencode auto-retries on certain errors. Adapter
should surface `attempt` and `message` to the user but not treat the retry
itself as terminal.

## Endpoint List Extracted from SDK

```
/auth/{providerID}                              PUT, DELETE
/log                                            POST
/event                                          GET (SSE)
/config                                         GET                  [LEAKS KEYS]
/provider                                       GET                  [LEAKS KEYS]
/agent                                          GET
/command                                        GET
/session                                        GET, POST
/session/status                                 GET
/session/{id}                                   GET
/session/{id}/abort                             POST
/session/{id}/children                          GET
/session/{id}/command                           POST
/session/{id}/diff                              GET
/session/{id}/fork                              POST
/session/{id}/init                              POST
/session/{id}/message                           GET, POST
/session/{id}/message/{messageID}               GET
/session/{id}/permissions/{permissionID}        PUT
/session/{id}/prompt_async                      POST  -> 204
/session/{id}/revert                            POST
/session/{id}/share                             POST
/session/{id}/shell                             POST
/session/{id}/summarize                         POST
/session/{id}/todo                              GET
/session/{id}/unrevert                          POST
```

If a PR claims "this endpoint doesn't exist" or "we should remove this
unused endpoint", verify against this list before agreeing.
