# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-05-06

### Changed

- Re-architected the repair runtime around the official `@opencode-ai/sdk`
- Standardized on a local server-managed OpenCode flow that reuses or auto-starts `opencode serve`
- Removed remaining product-facing references to alternate OpenCode transport modes
- Simplified the settings story so model selection is driven by the OpenCode config-backed picker

### Added

- `opencodeServerManager.ts` for local server detection, startup, and reuse
- `opencodeSdkClient.ts` for SDK-backed session, event, abort, and message access
- `opencodeTurnRunner.ts` for ordered turn execution: subscribe, create session, prompt, wait for hard terminal
- Synthetic successful-fix explanations when OpenCode applies a patch without persisting a compliant explanation
- A strict successful-fix explanation contract: `Problem:` / `Fix:` / `Why it works:`
- Regression coverage for:
  - applied patch with no assistant explanation
  - applied patch followed by `MessageAbortedError`
  - successful fix preserving other diagnostics in the same file

### Fixed

- Successful repairs no longer surface `Explanation unavailable`; the host now fills the gap with a synthetic explanation when needed
- A successful applied patch is no longer misclassified as failed when a later assistant explanation message aborts
- Fixing one diagnostic no longer clears unrelated highlights from the same file

## [0.4.0] - 2026-04-30

### Changed

- Consolidated the project around OpenCode-only repair flows
- Removed legacy product surface from older agent-loop and provider experiments
- Packaged the extension as a VSIX for local installation and release validation

## [0.2.0] - 2026-04-01

### Added

- Streaming Fix Details webview for repair progress
- Real-time text, tool call, and diff updates during repairs

## [0.1.0] - 2026-04-01

### Added

- Initial msSanitizer log parsing and diagnostics publishing
- Quick Fix entrypoints for single-problem and batch repair flows
