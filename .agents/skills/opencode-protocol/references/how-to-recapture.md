# How to Re-capture OpenCode Wire Evidence

The samples in `events/` are pinned to opencode 1.14.25 and
`@opencode-ai/sdk@1.3.2`. When opencode upgrades, re-run this procedure
to confirm the protocol contract still holds, or to update the captures.

## When to re-capture

- After bumping the bundled opencode version (check
  `~/.opencode/bin/opencode --version`).
- When `opencodeEventAdapter.ts` starts hitting unexpected events at runtime.
- Before changing finalize logic in `opencodeSession.ts`.

## Pre-flight

Use a scratch directory, not the repo. Make sure no real workload is
running.

```sh
mkdir -p /tmp/opencode-probe
cd /tmp/opencode-probe
```

Confirm the version on disk:

```sh
opencode --version
```

## Step 1: Start a serve

Always bind to loopback. Always set a password if you intend to keep the
server up for more than a quick capture.

```sh
PASS="dev-$(openssl rand -hex 8)"
OPENCODE_SERVER_PASSWORD="$PASS" \
  opencode serve --port 7777 --hostname 127.0.0.1 \
    --print-logs --log-level INFO \
    > /tmp/opencode-probe/serve.log 2>&1 &
SERVE_PID=$!
sleep 3
lsof -i :7777
```

**Without a password, `/config` and `/provider` leak your API keys.** See
`security.md`. Do not skip this.

## Step 2: Capture an idle baseline

```sh
perl -e 'alarm shift; exec @ARGV' 4 \
  curl -sS -N -H 'Accept: text/event-stream' \
  http://127.0.0.1:7777/event > /tmp/opencode-probe/sse-idle.txt
```

You should see `server.connected` and `session.created` events on any
new connection (server emits them eagerly).

## Step 3: Capture a full prompt cycle

```sh
# Subscribe in background, 60s window
perl -e 'alarm shift; exec @ARGV' 60 \
  curl -sS -N -H 'Accept: text/event-stream' \
  http://127.0.0.1:7777/event > /tmp/opencode-probe/sse-prompt.txt &
SSE_PID=$!
sleep 1

# Create session
SES=$(curl -sS -X POST http://127.0.0.1:7777/session \
  -H 'Content-Type: application/json' -d '{}' \
  | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))')

# Fire a smallest possible prompt with a connected provider
curl -sS -X POST "http://127.0.0.1:7777/session/$SES/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":{\"providerID\":\"<PROVIDER>\",\"modelID\":\"<MODEL>\"},\"parts\":[{\"type\":\"text\",\"text\":\"Reply ok\"}]}"

wait $SSE_PID
```

Substitute `<PROVIDER>` and `<MODEL>` from `GET /provider` (look at the
`connected` array). Use the cheapest available model.

## Step 4: Sanitize before commit

The raw capture contains your `sessionID`, `messageID`, slugs,
timestamps, and provider response headers. Strip them all:

```sh
node -e '
const fs = require("fs");
const src = process.argv[1];
const dst = process.argv[2];
let s = fs.readFileSync(src,"utf8")
  .replace(/ses_[A-Za-z0-9]+/g, "ses_<REDACTED>")
  .replace(/msg_[A-Za-z0-9]+/g, "msg_<REDACTED>")
  .replace(/prt_[A-Za-z0-9]+/g, "prt_<REDACTED>")
  .replace(/"slug":"[^"]+"/g, "\"slug\":\"<REDACTED>\"")
  .replace(/"title":"[^"]+"/g, "\"title\":\"<REDACTED>\"")
  .replace(/\b1[6-9]\d{11}\b/g, "<TS_MS>")
  .replace(/"cf-ray":"[^"]+"/g, "\"cf-ray\":\"<REDACTED>\"")
  .replace(/"x-trace-id":"[^"]+"/g, "\"x-trace-id\":\"<REDACTED>\"")
  .replace(/"set-cookie":"[^"]+"/g, "\"set-cookie\":\"<REDACTED>\"")
  .replace(/"date":"[^"]+"/g, "\"date\":\"<REDACTED>\"")
  .replace(/"directory":"[^"]+"/g, "\"directory\":\"/path/to/workspace\"")
  .replace(/"cwd":"[^"]+"/g, "\"cwd\":\"/path/to/workspace\"");
fs.writeFileSync(dst, s);
' /tmp/opencode-probe/sse-prompt.txt \
  .claude/skills/opencode-protocol/events/captured-prompt-cycle.sse.txt
```

## Step 5: Verify no secrets escaped

```sh
grep -RoE 'sk-[A-Za-z0-9_-]{20,}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' \
  .claude/skills/opencode-protocol/events/
```

Empty output = clean. If anything matches, extend the sanitizer above
and re-run.

## Step 6: Stop the serve and clean up

```sh
kill $SERVE_PID 2>/dev/null
rm -rf /tmp/opencode-probe
```

## Step 7: Update the SDK extract

If you bumped opencode, the SDK type generation may have changed.
Re-extract:

```sh
SDK=$(npm root -g)/@opencode-ai/sdk/dist/gen
awk '/^export type Event[A-Z]/ {n=$3; f=1; next} f && /type:/ {print n,$0; f=0}' \
  $SDK/types.gen.d.ts \
  > /tmp/event-extract.txt
```

Compare against `references/sdk-event-union.md`. Any new event types
should be added to the catalog and the adapter's known-events list.

## Step 8: Confirm the existing fixture suite still passes

```sh
npm test -- --grep opencode
```

If a fixture now fails because of a protocol change, the wire format
moved underneath us — investigate before "fixing" the fixture.

---

Captured 2026-04-26 by Claude Code (Opus 4.7) against opencode 1.14.25.
