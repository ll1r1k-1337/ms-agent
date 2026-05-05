---
name: msagent-plugin-real-fixture-test
description: Test the msAgent VS Code extension against real fixtures from test/fixtures and test/fixtures-src. Use this skill whenever the user asks to smoke test the plugin UI, validate a VSIX, verify Parse Log or Fix flows on real samples, run a regression pass before release, or automate msAgent acceptance testing with agent-browser.
---

# msagent-plugin-real-fixture-test

Use this skill to run a repeatable acceptance pass for the msAgent VS Code extension with real fixture data.

This workflow intentionally has two layers:

1. `agent-browser` UI smoke testing in an isolated VS Code profile.
2. Command-level local OpenCode integration verification against the same real source pattern.

The UI layer proves the packaged extension is installed and usable.
The integration layer proves the real repair pipeline still works when `opencode serve` is auto-started or reused.

## When to use

Use this skill whenever the task is any of:

- "test this VS Code plugin"
- "smoke test the VSIX"
- "verify Parse Log still works"
- "check the Fix Details flow"
- "run a real fixture regression"
- "do release validation before packaging"

Prefer this skill over ad hoc testing because it reuses the repo fixtures and isolates VS Code state.

## Inputs you need

- Repo root: the current workspace root
- VSIX path: usually `<repo_root>/msagent-<version>.vsix`
- OpenCode CLI path
- Model name
- Serve port

If the user does not specify these, use:

- CLI path: auto-detect `opencode` from `PATH`, then fall back to `$HOME/.opencode/bin/opencode`
- Port: `7331`
- Model: `opencode/big-pickle`

## Files this skill relies on

- `test/fixtures/out_of_bounds.log`
- `test/fixtures-src/add_custom.cpp`
- `test/integration/localOpencode.integration.test.ts`
- `docs/TEST_GUIDE.md`

## Workflow

### 1. Prepare the isolated UI workspace

Run:

```bash
bash .agents/skills/msagent-plugin-real-fixture-test/scripts/setup_ui_workspace.sh \
  /absolute/path/to/repo \
  /absolute/path/to/msagent-0.5.0.vsix \
  opencode/big-pickle
```

That script will:

- create `/private/tmp/msagent-ui-test`
- create isolated VS Code `userdata` and `extensions` dirs
- copy the real log and source fixtures into the temp workspace
- write `.vscode/settings.json`
- write `TEST_HARNESS.md`
- install the VSIX into the isolated profile
- auto-detect the OpenCode CLI unless you pass it explicitly

If auto-detection is not enough, pass the CLI path and port explicitly:

```bash
bash .agents/skills/msagent-plugin-real-fixture-test/scripts/setup_ui_workspace.sh \
  /absolute/path/to/repo \
  /absolute/path/to/msagent-0.5.0.vsix \
  opencode/big-pickle \
  /absolute/path/to/opencode \
  7331
```

### 2. Launch isolated VS Code for agent-browser

Run:

```bash
open -na "Visual Studio Code" --args \
  --disable-gpu \
  --user-data-dir /private/tmp/msagent-ui-test/userdata \
  --extensions-dir /private/tmp/msagent-ui-test/extensions \
  --remote-debugging-port=9223 \
  /private/tmp/msagent-ui-test/workspace
```

Then connect:

```bash
HOME=/private/tmp/msagent-ui-test agent-browser connect 9223
```

Important:

- Keep `HOME=/private/tmp/msagent-ui-test` on all `agent-browser` commands so its socket and state stay writable and isolated.
- Keep `--disable-gpu` on macOS. Without it, screenshots can go black.

### 3. Run the UI smoke test with agent-browser

Always re-snapshot after state changes because refs become stale.

Baseline commands:

```bash
HOME=/private/tmp/msagent-ui-test agent-browser tab
HOME=/private/tmp/msagent-ui-test agent-browser snapshot -i
```

#### Validate command registration

1. Open Quick Access.
2. Search `>msAgent`.
3. Confirm these commands are visible:
   - `msAgent: Clear Diagnostics`
   - `msAgent: Fix All Issues`
   - `msAgent: Fix Problem by Index`
   - `msAgent: Get AI Fix Queue States`
   - `msAgent: Open Settings`
   - `msAgent: Parse Log File`
   - `msAgent: Select OpenCode Model`

Recommended command sequence:

```bash
HOME=/private/tmp/msagent-ui-test agent-browser press Meta+Shift+p
HOME=/private/tmp/msagent-ui-test agent-browser snapshot -i
HOME=/private/tmp/msagent-ui-test agent-browser fill @ref \">msAgent\"
HOME=/private/tmp/msagent-ui-test agent-browser snapshot -i
```

#### Validate settings page

Run `msAgent: Open Settings` and confirm the `msAgent` setting group shows:

- `modelName`
- `opencodeApiKey`
- `opencodeCliPath`
- `opencodeServePort`
- `timeoutMs`

#### Validate model selection

Run `msAgent: Select OpenCode Model` and confirm the Quick Pick loads models from local OpenCode config.

Take screenshots when useful:

```bash
HOME=/private/tmp/msagent-ui-test agent-browser screenshot /private/tmp/msagent-ui-test/msagent-settings.png
HOME=/private/tmp/msagent-ui-test agent-browser screenshot /private/tmp/msagent-ui-test/msagent-model-picker.png
```

### 4. Treat Parse Log UI as a bounded smoke test

The isolated workspace includes:

- `/private/tmp/msagent-ui-test/workspace/test/out_of_bounds.log`
- `/private/tmp/msagent-ui-test/workspace/test/add_custom.cpp`
- `/private/tmp/msagent-ui-test/workspace/TEST_HARNESS.md`

The harness markdown contains command links for:

- `msagent.parseLog`
- `msagent.openSettings`
- `msagent.selectModel`

Current limitation:

- Markdown preview command links live inside a VS Code webview iframe.
- `agent-browser` can inspect the outer workbench reliably, but iframe command-link interaction is not yet stable enough to count as deterministic automation.
- Native file pickers opened by `msAgent: Parse Log File` are also a poor fit for browser-only automation.

Because of that, do **not** claim full Parse Log end-to-end success from the UI layer unless you actually observe diagnostics appear in Problems.

If you need a hard assertion for real fixture behavior, use the integration layer below.

### 5. Run the real repair integration check

This is the authoritative fixture-backed behavior check.

Run:

```bash
MSAGENT_LOCAL_MODEL='opencode/big-pickle' \
MSAGENT_LOCAL_OPENCODE_CLI_PATH="$(command -v opencode || echo "$HOME/.opencode/bin/opencode")" \
MSAGENT_LOCAL_OPENCODE_PORT='7331' \
npm run test:integration -- --grep 'OpenCode local integration'
```

What this validates:

- msAgent can auto-start `opencode serve` when the port is cold
- msAgent can reuse the existing server on retry
- the backend creates a real OpenCode session
- no-edit first pass can trigger the repo's guarded retry path
- the run settles without violating the repo's completion safety rules
- real fixture source content is preserved on failure and changed only on safe apply

### 6. Report results clearly

Split results into:

- `UI smoke: passed / failed / partial`
- `Real integration: passed / failed`
- `Known automation limits`

Good reporting language:

- "Command registration, settings, and model picker passed in isolated VS Code."
- "Parse Log UI entry exists, but native dialog and webview command-link automation remain a known gap."
- "Real OpenCode integration against the fixture-backed source passed."

## Troubleshooting

### Black screenshots

Relaunch VS Code with `--disable-gpu`.

### `agent-browser connect` fails

Relaunch VS Code with `--remote-debugging-port=9223` and wait a few seconds before connecting.

### State leaks between runs

Delete `/private/tmp/msagent-ui-test` and rerun the setup script.

### `opencode` integration test fails immediately

Check:

- `MSAGENT_LOCAL_MODEL`
- `MSAGENT_LOCAL_OPENCODE_CLI_PATH`
- `MSAGENT_LOCAL_OPENCODE_PORT`
- that `opencode --help` works in the shell

### Parse Log still cannot be fully automated in UI

Do not paper over it. Report it as a current harness limit and rely on the integration test for the real fixture assertion.

## Output format

Use this report shape:

```markdown
## UI Smoke
- Passed: ...
- Partial: ...
- Failed: ...

## Real Fixture Integration
- Command: `...`
- Result: passed/failed
- Notes: ...

## Artifacts
- Screenshot: `/absolute/path/...png`
- Workspace: `/private/tmp/msagent-ui-test/workspace`

## Known Limits
- ...
```
