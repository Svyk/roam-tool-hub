# Changelog

All notable changes to this project follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
