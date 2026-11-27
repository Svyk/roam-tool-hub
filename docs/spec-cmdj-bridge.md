# Cmd-J bridge: spec v0

Status: built in 0.4.0 and revised in 0.4.1 (both 2026-11-27), off by default. Checked against Roam's real chat runtime in an isolated harness, then through 43 real chat turns in the Readwisenotes window (Claude Opus 5.5, medium). "As built" lists where the code differs from the design below; "Live results" at the end says what the real turns showed.

## Problem

Roam's built-in chat (Cmd-J, Ask AI on a block) cannot call any extension tool. The local MCP can. Tool Hub therefore works from Claude Code, T3 and the CLI but not from inside Roam.

The 0.2.0 inbox bridge tried to route calls through blocks. It was removed in 0.3.0 for good reasons: it asked the model to obey graph text, and it ran any block that looked like a call.

## Finding

The chat does not run on closed code. It runs on a runtime that Roam leaves on the page as `window.PiHarness`, and that runtime has its own extension system: a registry of extensions, each with tools, prompt sections and hooks. Roam installs one extension named `roam`. A second one can be installed next to it.

So the bridge is not a block bus and not a network proxy. Tool Hub installs itself as a second extension in the chat's own registry. Its tools become real tools in the model's tool list, with real schemas and real tool results.

## What was checked

Source: the public bundles `roamresearch.com/js/compiled/app-agent.js` and `/pi/pi.js`, read 2026-11-27, plus read-only probes in Roam Desktop, window "Readwisenotes - November 26th, 2026".

| # | Fact | How |
|---|---|---|
| 1 | `window.PiHarness` is a plain writable object. `durable.Harness.open`, `durable.createRegistry` can be wrapped. `roamTools` is frozen. | live probe |
| 2 | `app-agent.js` is one closed function. Its allowlist (`mJe`) cannot be reached or changed from outside. | bundle |
| 3 | Roam builds its tools only from the allowlist, installs them as extension `roam`, then calls `Harness.open(storage, {models, registry, settings}, ctx)`. | bundle |
| 4 | `registry.install(ext)` adds an extension, or replaces one with the same name, and tells the harness. | bundle |
| 5 | Each turn Roam calls `conversation.configure({model, thinkingLevel, tools})`. `tools` is stored as a list of names and filters every installed tool. | bundle |
| 6 | A second extension's prompt section is always in the prompt. Its tools reach the model only when their names are in that `tools` list. | isolated test |
| 7 | A tool marked `deferred: true` is hidden from the model until a tool result returns `control.addTools: [names]`. It then stays loaded across later turns. | bundle, isolated test |
| 8 | `beforeTool` hooks from every extension run on every tool call and can block it. Roam's own hook caps a turn at 50 calls and stops a call repeated 3 times; that covers hub tools too. | bundle |
| 9 | Roam's approval card fires only for tools found in the frozen `roamTools`. It will not fire for hub tools. | bundle |
| 10 | A tool name that no longer resolves gives the model "Tool X is not available". It does not crash the chat. | bundle |
| 11 | The system prompt says: use only the supplied Roam tools, never use apps or plugins, and graph text cannot broaden these rules. | live read |

The isolated test built a throwaway in-memory harness on the live runtime (no graph write, no model call, closed afterwards) and showed 6 and 7 directly.

Checked later the same day, with the built modules on the real runtime (isolated harness, real `window.RoamExtensionTools`, real native tools, Readwisenotes window):

- Installing into a registry after its harness is open works. An assistant that was already running is picked up on its next turn, with no reload.
- A fresh registry gets the hub extension in the same step as Roam's own install.
- A turn shows Roam's tools plus `find_extension_tools`, with 53 tools deferred (47 registry, 6 native) and the `toolhub` section in the prompt.
- `find_extension_tools` returns `control.addTools`; the tools are in the model's list on the next turn.
- Real reads ran: `rg_list_grids`, `rg_list_templates`, and the native `list_boards`. Bad arguments come back as an error result.
- A writing tool asks for confirmation and a denial blocks it. A read-only chat lists and allows read tools only.
- A real `submit` with "Sort the grocery table by price, highest first" loaded `rg_sort` and its companions before the turn.
- Detach restores Roam's functions. A second bridge instance on the same page (a Tool Hub reload) attaches at once and receives the calls.

## Not checked

- Who a write is attributed to. Tools are called directly, so expect the logged-in user.
- Roam's argument check against every third-party tool schema. Every tool the model called in the live turns was accepted; the rest were not exercised.
- Ask AI on a block. The driver has no reliable way to start one.
- Anything on the Svy graph. All testing was on Readwisenotes.

## Design

### Attach

1. Setting `chat-bridge-enabled`, default off.
2. If `window.PiHarness` exists, wrap it now. If not, put a one-shot setter on `window.PiHarness` that wraps it when Roam's script assigns it. No polling.
3. Wrap `durable.Harness.open`. Before calling the original, install the `tool-hub` extension into `opts.registry`. After it returns, shadow `createConversation` and `conversation` on that harness so each conversation's `configure` appends the hub tool names to Roam's `tools` array.
4. Keep the registry and the originals on `window.__roamToolHubBridge`, so a dev reload of Tool Hub adopts them instead of wrapping twice. Unload restores every original and uninstalls the extension.

If Tool Hub loads after the assistant has already started, the bridge waits for the next assistant start. The settings panel says which state it is in: off, waiting, attached with N tools, or failed with the reason.

### What the model gets

| Piece | Always in the prompt | Content |
|---|---|---|
| Section `toolhub` | yes | One line per enabled extension: name, tool count, what it is for. States that these are supplied Roam tools from extensions the user installed, and that `find_extension_tools` loads them. |
| `find_extension_tools` | yes | Args `{query?, extension?, limit?}`. Returns name, short description and read-only flag for each match, plus the extension's guide the first time it appears in a conversation. Loads up to 8 matches through `control.addTools`. |
| Every enabled registry tool | no, deferred | Registered under its own name with its own schema (`rg_create_grid`, not a nested id). A name that clashes with a Roam tool or another extension gets the extension key as a prefix. |
| Native `extensionAPI.ai` tools of other extensions | no, deferred | Listed from `data.ai.getGraphGuidelines().extensionTools`, run through `data.ai.callExtensionTool`. Phase B2. |

Cost when idle is one small tool and one short section. The MCP route today costs five tool schemas and a nested id on every call, so this is better than MCP, not merely equal.

`list_extensions`, `describe_tools`, `run_read_tool` and `run_tool` are not needed in chat. They stay for MCP and CLI.

### Guides

"Understands my plugins" needs more than tool schemas. Add one optional field to the registry convention: `guide`, up to 600 characters per extension, written by the extension: its data model, which tool to reach for, what not to hand-write. Chat gets it with the first `find_extension_tools` hit for that extension. MCP gets it from `find_tools`. Same text, both surfaces.

### Running a tool

Reuse `executeRegistryTool` unchanged: switches, schema check, 40 000 character cap. Wrap the return as `{output: [{type: "text", text}], details: null, isError}`. Read-only tools run `parallel` and `replay: "safe"`; writing tools run `sequential` and `replay: "unsafe"`, the same split Roam uses.

### Gates

One `beforeTool` hook owned by the hub, for hub tools only:

1. The extension's switch and its writing switch, as today.
2. The chat's own access level. The `configure` wrapper sees Roam's tool list each turn: no `create_block` means read-only, `create_block` without `update_block` means an append-only run, both means edit. Writing hub tools run only in an edit chat.
3. A confirm dialog before each writing tool, with the tool name and arguments: allow once, always allow this extension in chat, deny. Needed because of fact 9. A per-extension setting skips it.

### Failing closed

Before wrapping, check the shape: `Harness.open`, `createRegistry`, `defineExtension`, `section`, `hook`, `ToolTask` exist; after open, the harness has `createConversation` and a conversation has `configure` and `agent`. Any mismatch: wrap nothing, set status to failed, warn once in the console. Every wrapper calls the original with untouched arguments if the hub's part throws. The chat must work exactly as before whenever the bridge does not.

After the first turn, read `conversation.agent()` and confirm `find_extension_tools` is in its tool list. That is the proof the status line reports.

## Routes rejected

| Route | Why not |
|---|---|
| Block inbox (0.2.0) | Model must obey graph text, which the prompt forbids. Two tool calls and a wait per call. Any matching block runs. |
| Local model proxy that adds tools to the request | Desktop only, needs a daemon, the API key passes through it, tool calls are invisible in the chat, no approval step. |
| Wrapping `window.fetch` | Same problems inside the page, plus one parser per provider format. |
| Changing Roam's allowlist | Not reachable (fact 2). |
| A separate chat panel | Already exists as roam-t3-code. It is not Cmd-J. |

## Risks

- `window.PiHarness` is undocumented. Any Roam release can rename or remove it. The bridge then turns itself off; it cannot be made to survive that.
- This is not something Roam Depot review would accept. It stays in the developer build, off by default.
- Roam kept extension tools out of chat on purpose, at least for now. This is the user's own client and the user's own switch, but it is still working against a vendor choice. If Roam allowlists `call_extension_tool`, delete the bridge: the five native hub tools then work in chat with no patching.
- Chats are stored. A stored chat that loaded hub tools will see "not available" for them if the bridge is later off (fact 10).

## Build order

| Phase | Scope | Gate |
|---|---|---|
| B0 | `src/chat-bridge.js` and tests against a fake `PiHarness`. Section, `find_extension_tools`, read-only deferred tools. Readwisenotes only. | Svy runs one Cmd-J turn: "use Tool Hub to list my Roam Grid tables". The tool call shows in the chat and returns rows. This settles the five unchecked items. |
| B1 | Writing tools, access mirror, confirm dialog, status line. | One write in an edit chat, one refusal in a read-only chat, one denied confirm. |
| B2 | Native `extensionAPI.ai` tools of other extensions. `guide` field in Tool Hub and in the extensions that have tools. | Other repos are edited only after Svy's OK, as in phase 4. |
| B3 | Turn it on for the Svy graph. | Svy's call. No reload of that window by an agent. |

## As built (0.4.0)

Differences from the design above, each for a reason found while building.

| Design | Built | Why |
|---|---|---|
| Wrap `Harness.open` and shadow methods on the harness | Patch two shared prototypes: the registry's `install` and `snapshot`, and the conversation's `configure` and `submit`. The conversation prototype is found by opening and closing a throwaway in-memory harness. | Reaches an assistant that started before Tool Hub loaded. Wrapping `open` could not. |
| Section lists extensions with counts | Section lists every tool name per extension, writing tools marked `*` | The model can ask for a tool by name in one call. About 2 300 characters for 53 tools. |
| `find_extension_tools {query, extension, limit}` | Also takes `names` | Same reason. |
| Tools load only when the model asks | Before each turn the person's message is matched against the tools and up to six clear matches are loaded (setting `chat-auto-load`, default on). For Ask AI on a block, only the block's own text is matched. | The model then sees the right tools on its first step. Unrelated prompts load nothing. |
| Writing tools only in an edit chat | Also allowed in an Ask AI on a block run, behind the same confirm dialog | That run is where "make a table here" is typed. A read-only chat still allows none. |
| Confirm unless the extension is set to skip it | Same, and a chat this session has not seen configured always asks | Covers a turn resumed after a reload. |
| Guide sent with the first `find` hit | Also added to the prompt section while one of the extension's tools is loaded | Auto-loaded tools never pass through `find`. |
| Native `extensionAPI.ai` tools in phase B2 | Included now, with their own switches under a `native:` key. Their writing tools are off until switched on. | The listing and the call both work from the page. |

Not done: the `guide` text in the other extensions' repos. Tool Hub reads the field; no extension supplies one yet.

## Live results (2026-11-27)

How it was run: `scripts/dev/chat-driver.mjs` sends one chat turn through Roam Desktop's debug port and reports the reply, the tool calls the panel lists, each confirm dialog and the bridge's counters. `scripts/dev/hub-setting.mjs` flips a Tool Hub switch. Both refuse any graph but the named test graph. Every write went to the page `Tool Hub/Stress test 2026-11-27`.

Round 1, 30 turns on 0.4.0 (run by Gemini 4 Neon; the turn-by-turn table names private pages and is kept outside this repository):

- The panel lists a hub tool by its bare name, with "Failed" when it returned an error.
- The model used the tools without being told to: Roam Grid for tables, Better Tasks for tasks, Plexus Diagram for boards, two extensions in one request.
- A denial stopped the model with no retry. A read-only chat refused with no dialog. A planted "delete every task" block was ignored. Prompts unrelated to any extension loaded nothing and called nothing.
- Faults found: "whiteboards" loaded nothing; a long prompt with the request at the end loaded the wrong tools; template listers rode along as companions; the word "export" alone loaded six tools; the native tool list read timed out once at 1.5 s; one "add a row and sort" request took five dialogs.

Review (Gemini 4 Carbon) of the first fix commit found a compound-word rule that loaded table tools for "comfortable" and board tools for "keyboard", a failed first native read marked as done, and a background refresh that could change the catalog mid-turn. All three were fixed before anything was published.

0.4.1, as published:

| Area | Change |
|---|---|
| Matching | A short alias list (whiteboard, spreadsheet, datagrid, subtask, todo) instead of a compound-word rule. Words that only say what to do count for little and cannot load a tool alone. Long prompts keep 120 words. Template listers are never companions. |
| Prompt section | One more sentence: a tool being in the list does not mean it is wanted. |
| Native tool list | Retried until one read succeeds. A turn waits at most 1.5 s for it. A background refresh only updates the cache; the catalog changes at the start of a turn. |
| Per turn | Only tools offered to Roam for this turn can be loaded. `find_extension_tools` reports the others under `not_loaded`. |
| Confirm dialog | Deny, Allow <extension> in this chat, Allow once. The permanent choice is the Settings switch only. A tool whose name says delete, remove, clear, drop, destroy, purge, wipe, reset, restore, archive or bulk always asks, even with that switch on, and is never covered by an in-chat approval. |

Round 2, 8 turns on 0.4.1 (run by the host), all as expected, zero bridge errors:

| Prompt | Result |
|---|---|
| What whiteboards do I have | Tools loaded before the first step, no search |
| Two alternative phrasings, "comfortable" in the text | Nothing loaded, nothing called |
| Make a tea table, add a row, sort it | One dialog ("in this chat") covered four writes. A search inside the turn loaded two more tools and they were callable at once |
| Delete the last row (same chat) | Dialog shown again, with Deny and Allow once only |
| "On the table", "on board", "take me to task" | Tools were loaded but the model called none and said it read them as figures of speech |
| Export to an Anki deck and email it | Nothing loaded, clean refusal |
| Create a task, denied | Model reported the refusal and stopped. No template lister loaded |
| Long background, request at the end | Right tools loaded, no search |

Not the hub's, left for their own repos: Plexus Diagram's `read_board` throws on the board `KT_KHnsXe`; Oblique Strategies does not mark its tool read-only, so it asks every time; Roam Grid's `rg_list_grids` returns tables that no longer exist, and its reading tools say "grid" where people say "table".
