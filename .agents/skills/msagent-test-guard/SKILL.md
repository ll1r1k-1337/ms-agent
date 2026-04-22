---
name: msagent-test-guard
description: >
  Test coverage guard for the msAgent project. Activate after any code change — bugfix, new feature,
  refactoring, or config update. Analyzes what changed, determines whether existing tests cover the
  change, writes missing tests, and runs the full suite with coverage. Use this skill whenever you
  finish editing source files in src/, add a new feature, fix a bug, or the user asks to run tests
  or check coverage. Even if the user just says "done" or "that's fixed", trigger this skill to
  verify nothing regressed.
---

# msAgent Test Guard

Every code change deserves a test check. This skill ensures that after any modification to the
msAgent VSCode extension, the test suite stays green and the change is covered.

## When This Skill Activates

- After editing any file in `src/`
- After adding a new feature or fixing a bug
- After refactoring existing code
- When the user asks to run tests or check coverage
- Before declaring any task "done"

## Project Test Infrastructure

| Item | Value |
|------|-------|
| Test runner | Mocha (`.mocharc.yml`) |
| Assertion style | Chai `expect` |
| Mocking | Sinon |
| File pattern | `src/**/*.test.ts` — tests live next to source |
| Transpilation | `ts-node/register` |
| Fixtures | `test/fixtures/` (log files), `test/fixtures-src/` (source files) |
| Fixture helper | `import { fixturePath, sourcePath } from '../test/setup'` |
| VSCode mock | `src/test/mocks/vscode.ts` |

**Commands:**
- `npm test` — run all unit tests
- `npm run test:coverage` — run with c8 coverage report

## Workflow

### Step 1: Identify what changed

Read the diff or recall the files you just edited. For each changed source file (not `.test.ts`),
note the module and what behavior was added, modified, or removed.

### Step 2: Map changes to existing tests

For each changed source file, find its corresponding test file:
- `src/parser/logParser.ts` → `src/parser/logParser.test.ts`
- `src/llm/openaiCompatProvider.ts` → `src/llm/openaiCompatProvider.test.ts`
- `src/llm/provider.ts` → `src/llm/provider.test.ts`
- `src/agent/message.ts` → `src/agent/message.test.ts`
- `src/tools/toolHandlers.ts` → `src/tools/toolHandlers.test.ts`

If a test file exists, read it. Ask: does the existing test suite cover the new/changed behavior?
If no test file exists for the changed module, one needs to be created.

### Step 3: Determine if new tests are needed

New tests are needed when:
- A new function, method, or class was added
- A function's behavior changed (different return value, new error case, different URL construction)
- A new configuration option was introduced (e.g., `apiVersion` auto-detection)
- A bug was fixed — the fix should have a regression test proving the old behavior was wrong
- A new branch or edge case was introduced in existing logic

Tests are NOT needed when:
- Only comments, formatting, or import order changed
- The change is in a file that already has a test covering the exact new behavior

### Step 4: Write missing tests

Follow the project's existing patterns exactly:

```typescript
import { expect } from 'chai';
// For log parser tests:
import { fixturePath } from '../test/setup';
```

**Test structure:**
```typescript
describe('ModuleName', () => {
    describe('functionName', () => {
        it('should do X when Y', () => {
            // arrange
            const input = ...;
            // act
            const result = functionName(input);
            // assert
            expect(result).to.equal(expected);
        });
    });
});
```

**For HTTP-based tests (LLM provider):** Use a local `http.createServer` on a high port
(see `openaiCompatProvider.test.ts` for the pattern). Route different paths to different
mock responses.

**For file-based tests (toolHandlers):** Use `os.tmpdir()` with `beforeEach`/`afterEach`
cleanup — never touch real project files.

**For parser tests:** Use fixture files from `test/fixtures/`. If a new error type needs
testing, create a new `.log` fixture in `test/fixtures/`.

### Step 5: Run tests

```bash
npm test
```

If any test fails, fix the issue — either the test was written wrong or the source code has
a problem. Do not skip or delete failing tests.

### Step 6: Run coverage check

```bash
npm run test:coverage
```

Review the coverage output. Pay attention to:
- Lines that were changed but have low coverage
- Branches that are untested (e.g., the new `hasVersion` regex check)
- Functions with 0% coverage — these are red flags

Coverage below ~70% on changed modules means more tests are needed.

### Step 7: Report results

State clearly:
1. What tests were added (file paths and test names)
2. Whether `npm test` passes
3. Coverage summary for changed modules
4. Any gaps that remain and why (e.g., VSCode API mocking limitations)

## Common Test Patterns for This Project

### Testing the LLM provider URL construction

The `OpenAICompatProvider.chat()` method constructs the API URL from `config.endpoint`. To test
URL routing, inspect `req.url` in the mock server handler:

```typescript
it('should append /v1/chat/completions for endpoints without version path', async () => {
    // Server captures req.url — verify it ends with /v1/chat/completions
    const provider = new OpenAICompatProvider({ endpoint: 'http://localhost:PORT', modelName: 'm' });
    await provider.chat([textMessage('hi')], []);
    // Check lastRequestUrl captured by server
});
```

### Testing the config reader

`getLLMConfig()` reads from `vscode.workspace.getConfiguration`. Since VSCode APIs are mocked
in `src/test/mocks/vscode.ts`, update the mock to test different config scenarios.

### Testing parser with new log formats

Create a new fixture file in `test/fixtures/` that matches the mssanitizer output format, then
write a test that calls `parseLogFile(fixturePath('new_format.log'))` and asserts on the
diagnostics.
