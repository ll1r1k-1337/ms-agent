#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  cat <<'EOF'
Usage:
  setup_ui_workspace.sh <repo_root> <vsix_path> [model] [cli_path] [port]

Example:
  setup_ui_workspace.sh \
    /Users/me/projects/ms-agent \
    /Users/me/projects/ms-agent/msagent-0.5.0.vsix \
    opencode/big-pickle \
    /Users/me/.opencode/bin/opencode \
    7331
EOF
  exit 1
fi

REPO_ROOT=$1
VSIX_PATH=$2
MODEL_NAME=${3:-opencode/big-pickle}
CLI_PATH=${4:-/Users/yangchenhua/.opencode/bin/opencode}
SERVE_PORT=${5:-7331}

TMP_ROOT=/private/tmp/msagent-ui-test
WORKSPACE_DIR=$TMP_ROOT/workspace
EXTENSIONS_DIR=$TMP_ROOT/extensions
USERDATA_DIR=$TMP_ROOT/userdata
TEST_DIR=$WORKSPACE_DIR/test
SETTINGS_DIR=$WORKSPACE_DIR/.vscode

rm -rf "$TMP_ROOT"
mkdir -p "$TEST_DIR" "$EXTENSIONS_DIR" "$USERDATA_DIR" "$SETTINGS_DIR"

cp "$REPO_ROOT/test/fixtures/out_of_bounds.log" "$TEST_DIR/out_of_bounds.log"
cp "$REPO_ROOT/test/fixtures-src/add_custom.cpp" "$TEST_DIR/add_custom.cpp"

cat > "$SETTINGS_DIR/settings.json" <<EOF
{
  "msagent.opencodeCliPath": "$CLI_PATH",
  "msagent.opencodeServePort": $SERVE_PORT,
  "msagent.timeoutMs": 120000,
  "msagent.modelName": "$MODEL_NAME"
}
EOF

python3 - <<'PY' "$WORKSPACE_DIR/TEST_HARNESS.md"
import json
import sys
import urllib.parse

target = sys.argv[1]

def command_uri(command, args):
    return f"command:{command}?{urllib.parse.quote(json.dumps(args, ensure_ascii=False))}"

lines = [
    "# msAgent UI Test Harness",
    "",
    f"- [Run `msagent.parseLog` on fixture log]({command_uri('msagent.parseLog', ['/private/tmp/msagent-ui-test/workspace/test/out_of_bounds.log'])})",
    f"- [Run `msagent.openSettings`]({command_uri('msagent.openSettings', [])})",
    f"- [Run `msagent.selectModel`]({command_uri('msagent.selectModel', [])})",
    "",
    "Fixture files:",
    "",
    "- `test/out_of_bounds.log`",
    "- `test/add_custom.cpp`",
]

with open(target, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")
PY

code --install-extension "$VSIX_PATH" \
  --extensions-dir "$EXTENSIONS_DIR" \
  --user-data-dir "$USERDATA_DIR" \
  --force

cat <<EOF
Prepared isolated workspace:
  workspace:      $WORKSPACE_DIR
  extensions dir: $EXTENSIONS_DIR
  user data dir:  $USERDATA_DIR

Launch VS Code:
  open -na "Visual Studio Code" --args --disable-gpu --user-data-dir "$USERDATA_DIR" --extensions-dir "$EXTENSIONS_DIR" --remote-debugging-port=9223 "$WORKSPACE_DIR"

Connect agent-browser:
  HOME=$TMP_ROOT agent-browser connect 9223
EOF
