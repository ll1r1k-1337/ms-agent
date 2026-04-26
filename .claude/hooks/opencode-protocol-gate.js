#!/usr/bin/env node
// PreToolUse gate: block Edit/Write on opencode backend files unless the
// opencode-protocol skill has been consulted in the current session.
//
// Wired up from .claude/settings.json. Reads Claude Code hook JSON on stdin.
// Outputs a hookSpecificOutput JSON blob; exits 0 on allow, 2 on deny.
//
// Escape hatch: set OPENCODE_PROTOCOL_GATE=skip to bypass (intended only
// for emergency edits where re-reading the skill is impossible).

'use strict';

const fs = require('fs');

const PROTECTED_PATTERNS = [
  /\/src\/backends\/opencode[A-Z][A-Za-z]*\.ts$/,
  /\/src\/backends\/openCodeFixBackend\.ts$/,
  /\/test\/fixtures\/llm-scenarios\/[^/]+\.json$/,
];

const SKILL_KEYWORDS = [
  'opencode-protocol',
  '.claude/skills/opencode-protocol/SKILL.md',
];

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function emit(decision, reason) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(payload));
  process.exit(decision === 'deny' ? 2 : 0);
}

function main() {
  if (process.env.OPENCODE_PROTOCOL_GATE === 'skip') {
    emit('allow', 'opencode-protocol gate bypassed via OPENCODE_PROTOCOL_GATE=skip');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(readStdin() || '{}');
  } catch {
    // Hook misconfigured or non-JSON stdin — fail open so we don't block all
    // tool calls if this script breaks.
    process.exit(0);
  }

  const toolName = payload.tool_name || '';
  const input = payload.tool_input || {};
  const filePath = input.file_path || input.path || '';
  const transcriptPath = payload.transcript_path || '';

  if (!['Edit', 'Write'].includes(toolName)) {
    process.exit(0);
  }
  if (!filePath) {
    process.exit(0);
  }
  const protectedHit = PROTECTED_PATTERNS.some((re) => re.test(filePath));
  if (!protectedHit) {
    process.exit(0);
  }

  let consulted = false;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const content = fs.readFileSync(transcriptPath, 'utf8');
      consulted = SKILL_KEYWORDS.some((kw) => content.includes(kw));
    } catch {
      consulted = false;
    }
  }

  if (consulted) {
    process.exit(0);
  }

  const reason =
    `[opencode-protocol gate] About to ${toolName} ${filePath} but the ` +
    `opencode-protocol skill has not been consulted in this session.\n\n` +
    `Required: invoke the opencode-protocol skill (Skill tool with ` +
    `skill="opencode-protocol") OR Read .claude/skills/opencode-protocol/SKILL.md.\n` +
    `Then cite which Hard Rule (R1-R6) and which Known Trap your change ` +
    `touches before retrying. See AGENTS.md and CLAUDE.md for the protocol ` +
    `summary.\n\n` +
    `Emergency bypass: set OPENCODE_PROTOCOL_GATE=skip in the environment.`;
  emit('deny', reason);
}

main();
