# Changelog

All notable changes to this project follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-26

### Removed

- Removed the experimental `roam/tool-hub/inbox` Cmd-J bridge (`cmd-j-bridge-enabled`): Roam's built-in `Cmd-J` system prompt explicitly prohibits driving plugins or broadening tool policy from graph content, and an ambient-authority block bus opens cross-client/untrusted-block risks. Tool Hub runs cleanly through Roam's sanctioned Local MCP `call_extension_tool` surface.

### Fixed

- Scoped the optional `roam/agent guidelines` heading explicitly to Local MCP (`call_extension_tool`) clients so built-in `Cmd-J` chat ignores it instead of refusing to write native Roam tables or tasks.
- `finalizeToolResult` now bounds the full JSON-serialized envelope (including escaped quotes in `resultPreview`) within `MAX_RESULT_CHARS` (`40,000`).
- Added cycle and depth guards to `validateAgainstSchema` / `deepEqual`, plus a `try/catch` guard in `executeRegistryTool` so cyclic or malformed third-party schemas never overflow the stack.
- Fixed `sanitizeRoamMarkup` to neutralize repeated Roam delimiters (`[[[`, `{{{`, `(((`, `:::`) and backticks cleanly.
- Fixed `drainGuidelinesQueue` to return the in-flight promise when already running, and prevented `syncGuidelinesIndex` from falling back to a phantom page UID when `page.create` fails.

## [0.2.0] - 2026-11-26

### Added

- Opt-in **Cmd-J inbox bridge** (`cmd-j-bridge-enabled`, default OFF) watching `[[roam/tool-hub/inbox]]` via a single `addPullWatch` so Roam's built-in `Cmd-J` chat can invoke all 5 Tool Hub actions via `create_block` + `get_block` with full switch/schema enforcement, cross-tab Web Locks deduplication, pre-existing-block replay protection, and automatic history pruning.
- Automatic Cmd-J inbox protocol instructions (with exact inbox page UID) included in the `roam/agent guidelines` block when both settings are enabled.

## [0.1.0] - 2026-11-26

### Added

- Native Roam AI hub tools via `extensionAPI.ai.addTool`: `list_extensions`, `find_tools`, `describe_tools`, `run_read_tool`, and `run_tool`.
- Live reader for `window.RoamExtensionTools` with on-demand discovery (no polling, no keydown handlers).
- Zero-dependency JSON Schema draft-07 subset validator for registry tool arguments.
- Per-extension settings switches (read tools on by default, writing tools off by default) with Roam-safe key encoding and on-demand refresh.
- AI write attribution via `context.asTokenUser` plus `context` forwarding, error catching with tool id, and 40,000-character result truncation.
- Optional generated index block on `roam/agent guidelines` (opt-in setting, upserted by stored block UID, zero writes when unchanged, grouped summary above 20 extensions, removed when switched off, preserved across unload/reload).
- Unit tests against a fake registry and deterministic browser-ESM build (`extension.js`, `extension.css`, and matching `deploy/`).
