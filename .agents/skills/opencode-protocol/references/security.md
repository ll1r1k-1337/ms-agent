# OpenCode Server Mode — Security Notes

Captured against opencode 1.14.25 on 2026-04-26.

## Finding 1: Unsecured server leaks API keys

When `opencode serve` is started without `OPENCODE_SERVER_PASSWORD`, the
server prints a warning at boot:

```
Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
```

Two HTTP endpoints then return provider credentials in plaintext to any
caller that can reach the bound port:

- `GET /config` — returns the user's full opencode config including
  `provider.<id>.options.apiKey`.
- `GET /provider` — returns the resolved provider catalog including the
  same `apiKey` values inside `options`.

A `curl` from any process on the same machine (or any host that can reach
the bind address) walks away with usable credentials. The default
`--hostname 127.0.0.1` limits exposure to localhost, but local processes
can still scrape it.

### Implications for `OpenCodeFixBackend`

When the extension spawns a serve subprocess (in `opencodeTransport.ts`),
it MUST:

1. Generate a random `OPENCODE_SERVER_PASSWORD` per spawn.
2. Pass it through the child's environment.
3. Send `Authorization: Bearer <password>` (or whatever scheme opencode
   expects when password is set — verify against the running build) on
   every request from the extension.
4. Bind only to `127.0.0.1`. Never `0.0.0.0`. Never `--mdns`.
5. Pick a random ephemeral port unless the user set one explicitly.

### Implications for tests / fixtures

Capturing real SSE for the `events/` directory must always be done against
a serve started for that purpose, in a scratch cwd, and the resulting
files must be passed through `references/how-to-recapture.md`'s sanitizer
before being checked in. Never commit raw `/tmp` captures.

## Finding 2: Unknown `type` events tolerated by reality

`server.heartbeat` is emitted by opencode 1.14.25 but is not declared in
the `@opencode-ai/sdk@1.3.2` `Event` discriminated union. Future opencode
versions can introduce new types at any time; adapter code must:

- Treat unknown `type` as a no-op (log at debug, do not throw).
- Never use unknown events as a terminal signal.

## Finding 3: SSE is plaintext

`GET /event` returns `text/event-stream` over plain HTTP on the loopback
interface. Anyone with `lsof`-level access can intercept. This is normal
for localhost tools but document it so nobody is tempted to bind to a
non-loopback address.

## Threat Model Summary

| Threat | Mitigation in this repo |
|---|---|
| Local malware reads `/config` or `/provider` and exfiltrates keys | Spawn serve with `OPENCODE_SERVER_PASSWORD` and bind to 127.0.0.1 only |
| Other dev tool on the same box probes loopback | Same |
| Stale opencode process from a crashed extension run | `opencodeTransport.ts` must register a process exit handler that kills the child |
| Accidental commit of capture files containing real keys | All `events/*.sse.txt` files are sanitized by the procedure in `references/how-to-recapture.md`; CI grep should reject `sk-`, hex-uuid, and known provider key prefixes in `.claude/skills/` |
