# Tool Hub: spec v0

Status: draft from the host session, 2026-11-26. The implementing thread owns this file from here: correct anything that turns out wrong and say what changed.

## Goal

One Roam Depot extension that lets every AI surface Roam ships (the built-in chat, Ask AI, the local MCP, the CLI) find and run the tools of every installed extension, without loading every tool's schema into every session.

## Verified facts (2026-11-26)

Read the linked source before relying on any of these.

1. Official tool API. `extensionAPI.ai.addTool({name, description, handler, scope, inputSchema})` registers a tool. Roam lists it under `extensionTools` in `roamAlphaAPI.data.ai.getGraphGuidelines` and runs it through `roamAlphaAPI.data.ai.callExtensionTool`. Cap: 25 tools per extension, description up to 2000 chars, schema up to 4000 chars, draft-07, scopes `read | append | edit`. Marked experimental. Docs: `~/openkb-roam-plugin/raw/official-docs/developer-documentation/roam-depot-extension-api.md` (`extensionAPI.ai`) and `roam-alpha-api.md` (`roamAlphaAPI.ai`).
2. Who can call them. Local MCP, Local API, and CLI (`call_extension_tool` in `@roam-research/roam-tools-local` 0.11.1). **Corrected 2026-11-26 after live Phase 5 test**: although Roam's `pi.js` bundle contains the shared `call_extension_tool` definition, `app-agent.js` (Roam's built-in `Cmd-J` chat) filters the model's toolset through a hardcoded allowlist (`mJe` = `K2e` + `L2e`, 27 built-in tools) that **omits `call_extension_tool`**. Built-in chat therefore sees the `roam/agent guidelines` text but cannot invoke any `extensionAPI.ai.addTool` tool yet (neither Tool Hub nor native-tool extensions like Plexus Diagram / Task Status Tags). The remote MCP at `mcp.roamresearch.com` also does not support extension tools.
3. Cost of the flat list. Roam sends every registered tool with its full schema at the start of every session. On the Svy graph: 25.6 KB total, of which 8.6 KB is 11 tools from 2 extensions (Task Status Tags 5, Plexus Diagram 6). About 785 bytes per tool.
4. The second registry. `window.RoamExtensionTools[extKey] = {name, tools: [{name, description, parameters, execute(args), readOnly?, isMutating?}]}` is the convention Chief of Staff reads (`~/system-setup/plugins/upstream/chief-of-staff/src/index.js`, `getExternalExtensionTools`, `buildExtRouteTool`). Live on Svy today: 6 extensions, 51 tools (Roam Grid 24, Better Tasks 19, Definitions 2, Oblique Strategies 1, Deep Research 3, Export Document 2). None of these is visible to Roam chat or the MCP. Registered natively they would add roughly 22 KB to every session.
5. Prior art for nesting. Chief of Staff sends tools direct up to 15, and above that swaps to a discover tool and an execute tool, with descriptions cut to 300 chars and a per-extension on/off setting. Port the idea, not the code.
6. Checked write path pattern. `~/openkb-roam-plugin/raw/session-learnings/2026-11-24-extension-ai-tools.md` (Task Status Tags 0.17.0): handler guards, live enum in the schema, tool id format (`<extension id>/<name>`; a dev build's id is its URL with the trailing slash, so the id has a double slash).

## Design

### Tools the hub registers (native, via `extensionAPI.ai.addTool`)

| Tool | Scope | Does |
|---|---|---|
| `list_extensions` | read | One row per enabled extension: key, name, tool count, read/write counts, one-line summary |
| `find_tools` | read | Args `{extension?, query?, limit?}`. Returns name, description cut to 300 chars, read-only flag. No schemas |
| `describe_tools` | read | Args `{tools: [1..5 ids]}`. Full description and input schema |
| `run_read_tool` | read | Runs one tool, only if it is marked `readOnly: true` |
| `run_tool` | edit | Runs one enabled tool of any kind |

Tool ids inside the hub are `<extKey>/<toolName>` from the registry, for example `roam-grid/rg_get_grid`.

Two run tools exist because Roam enforces scope per registered tool: a read-only AI connection must not reach a writing tool through the hub. A tool with no `readOnly: true` is treated as writing.

Hub tool descriptions must tell the agent the order: `list_extensions` or `find_tools`, then `describe_tools`, then run. Keep each description short; they are sent every session.

### Rules for running a registry tool

- Validate args against the tool's `parameters` before calling `execute`. Hand-write a draft-07 subset (type, required, properties, items, enum, minimum, maximum, minItems, maxItems, minLength, maxLength, additionalProperties). Unknown keywords pass. No runtime dependency.
- Attribution: call `context.asTokenUser(() => tool.execute(args, context))` and await the returned value outside. Writes after the tool's first await are attributed to the logged-in user; that is a known limit of the registry convention. Record it in the README. Passing `context` as a second argument lets a tool that knows about it attribute later writes with `user-uid: context.tokenUserUid`.
- Catch throws and return `{error}` with the tool id. Cap result size (suggest 40 000 chars) and say when a result was cut.
- Never call a tool from an extension the user has switched off.

### Settings

- Per-extension switch, shown for every key found in the registry. Default for a newly seen extension: read tools on, writing tools off. One "allow writing tools" switch per extension.
- Re-read the registry when a tool is called, not on a timer. No keydown handlers, no polling, at most one command palette entry (Roam rebuilds its command map on every keystroke; see `roam_typing_lag_command_count` in project memory).

### Guidelines page index

- One generated block on `roam/agent guidelines`, titled so a person knows the hub owns it, with one child line per enabled extension (name, tool count, one-line purpose). Above 20 enabled extensions, write counts by group and point at `list_extensions`.
- Upsert by stored block uid, write only when the text differs, never touch other blocks on the page. A setting turns the index off and removes the block. Unload does not remove it, because unload also fires on reload.
- Do not write to the Svy graph's guidelines page until Svy says so. Build and test on the notes graph (Readwisenotes).

### Not in v0

- Pinning chosen tools as direct native tools to skip the extra hop.
- Adapters for Depot extensions that have a window API but no registry entry (SmartBlocks, Query Builder and others). Each needs its own check.
- Native tools from other extensions. They are already visible; the hub ignores them.

## Phases

1. Hub core: the five tools, validation, settings, unit tests with a fake registry. `npm run check` passes.
2. Live check on the notes graph through the Local API and the local MCP (`call_extension_tool` on `http://127.0.0.1:3100/mcp`, now on roam-tools-local 0.11.1): list, find, describe, run a read tool, confirm a writing tool is refused on a read-only connection and when its switch is off.
3. Guidelines index block.
4. Tools for our own extensions that have none. First write `docs/tools-plan.md`: one row per repo under `~/system-setup/plugins/roam/` with the tools worth having, or "none" with a reason (themes and the caret extension probably need none). Stop and show Svy the table before editing any other repo. New tools go in `window.RoamExtensionTools` so Chief of Staff and the hub both see them; handlers call the extension's own checked writers.
5. One built-in chat turn (cmd-j) that runs a hub tool. Svy runs this one.

## Working rules

- Read `~/.claude/skills/roam-plugin-dev/SKILL.md` and this repo's README before writing code.
- Commits: `git -c user.name="Svyatoslav Kleshchev" -c user.email="svyk@icloud.com" commit`. New commits only, no hook skipping.
- No GitHub repository, push or Pages site until Svy says go. Live testing needs the Pages URL, so ask when phase 1 passes.
- Roam Desktop's debug port is 9223. Never hard-reload the Svy window: the graph is encrypted and locks.
- Never transact `:harc/*` or `:entity/attrs`. Never rewrite `BT_attr*` blocks.
- Report what was run and what was not. No "should work".

## Implementation findings & clarifications (2026-11-26)

1. **Registry entries omit top-level `description`/`group` in practice**: Verified live on `Readwisenotes` (`roam-grid`, `better-tasks`, `oblique-strategies` expose `{name, version, tools}` only; 3 extensions, 44 tools total). Tool Hub derives a concise one-line `summary` from tool descriptions when `ext.description` is missing, and defaults `group` to `"Other"` when `ext.group` is missing.
2. **Roam settings key restrictions**: Verified in `roam-depot-extension-api.md` that `extensionAPI.settings.panel.create` rejects setting IDs containing `.`, `#`, `$`, `[`, or `]`. Tool Hub losslessly encodes extension keys (`~<hex>`) before forming `ext:<key>:enabled` and `ext:<key>:write` IDs.
3. **Read-only guard**: A tool is treated as read-only only when `tool.readOnly === true && tool.isMutating !== true`. On `Readwisenotes`, `oblique-strategies/os_random_strategy` omits `readOnly`, so it is treated as writing by default per the spec rule.
4. **Guidelines index default**: `guidelines-index-enabled` defaults to `false` (opt-in) so loading Tool Hub on any graph—including Svy—never writes to `roam/agent guidelines` until explicitly enabled in Settings. On `Readwisenotes`, `roam/agent guidelines` already exists (`uid: 2Xe52ygsw`) with a user block (`BtzKCfUjA`); Tool Hub only touches its own stored block UID.
5. **Built-in `Cmd-J` chat cannot call extension AI tools yet**: Live Phase 5 test on `Readwisenotes` (`YUWiDjdaD`) proved that `app-agent.js` reads `roam/agent guidelines` (so `Cmd-J` saw the Tool Hub Roam Grid entry) but restricts the model's tool list via a hardcoded allowlist (`mJe` / `K2e` / `L2e`) that excludes `call_extension_tool`. Tool Hub works live today through the **Local MCP** (`http://127.0.0.1:3100/mcp`), **Roam CLI**, and **Local API** (`data.ai.callExtensionTool`), and will work in built-in chat automatically once Roam adds `call_extension_tool` to `app-agent.js`'s allowlist.
6. **A bridge for built-in chat is designed, not built (2026-11-27)**: the chat runs on `window.PiHarness`, which has its own extension registry that a second extension can join. Design, evidence and build order are in `docs/spec-cmdj-bridge.md`.
