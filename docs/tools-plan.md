# Phase 4 Plan: Extension Tools for `~/system-setup/plugins/roam/`

Status: proposal for Svy's review. **No other repository has been edited.**

Convention for new tools: register under `window.RoamExtensionTools[<extKey>] = { name, version, description, group, tools: [...] }` so both Chief of Staff and Tool Hub see them without adding native schema bytes to every session. Every writing tool must route through the extension's own checked writer and accept `(args, context)` so writes after the first `await` can pass `"user-uid": context?.tokenUserUid`.

## Repository inventory (23 repos)

| Repo | Current AI / Registry status | Proposed `window.RoamExtensionTools` tools | Notes / Rationale |
|---|---|---|---|
| `roam-attr-charts` | None | `ac_list_charts` (read), `ac_query_series` (read), `ac_insert_chart` (write) | High value. Lets agents evaluate `{{plot: ...}}` specs through the extension's own parser/aggregator and read clean numeric series + stats (HRV, sleep, etc.) instead of hand-querying daily pages. |
| `roam-timeblock-organizer` | None | `tbo_get_schedule` (read), `tbo_find_conflicts` (read), `tbo_organize_page` (write) | High value. Exposes parsed `#TimeBlock` sessions and overlap detection (`#calendar`/`#concurrent`/`#no-conflict` respected) plus the checked `reorderBlocks` pass. |
| `roam-compass` | None | `compass_get_neighborhood` (read) | High value. Returns Compass's structured directional graph neighborhood (parents, children, friends, challengers, facets) for a page or block uid. Skip UI navigation writes for headless MCP. |
| `roam-hq` | None | `hq_list_replicas` (read), `hq_mark_replica` (write) | High value for task workflows. Reads the `roam/hq/metadata` / `HQ::` replica set and provides a checked writer that appends only a bare `HQ::` child under an existing TODO/DONE block (preserving `docs/task-plugin-contract.md`). |
| `roam-archive-todos` | None | `at_preview_archive` (read), `at_archive_page_todos` (write) | Medium value. Gives agents a dry-run preview and a bounded descendant-chain archive writer instead of ad-hoc block rewrites. |
| `roam-plexus` | None | `px_list_regions` (read), `px_get_region` (read) | Medium value. Lets agents discover Excalidraw region crops, captions, and refs. Region creation requires interactive canvas element selection, so keep it read-only. |
| `roam-t3-code` | None | `t3_bridge_status` (read), `t3_list_linked_threads` (read) | Low-to-medium value, strictly read-only. Lets agents see bridge health and Roam-to-T3 thread links; omit send/launch write tools to avoid agent-to-agent loops. |
| `better-tasks` | Registry (19 tools) | None (already registered) | Already exposes 19 tools on `window.RoamExtensionTools["better-tasks"]` (11 read-only, 8 writing). Optional polish: add top-level `description` and `group: "Tasks"` plus `context?.tokenUserUid` forwarding. |
| `roam-grid` | Registry (24 tools) | None (already registered) | Already exposes 24 tools on `window.RoamExtensionTools["roam-grid"]` (5 read-only, 19 writing). Optional polish: add top-level `description` and `group: "Tables"` plus `context?.tokenUserUid` forwarding. |
| `Roam-Task-Status-Tags` | Native `addTool` (5 tools) | None | Already registers 5 native tools via `extensionAPI.ai.addTool` (`list_statuses`, `get_task_status`, `list_tasks`, `status_counts`, `set_task_status`). Hub intentionally ignores native tools because Roam already exposes them directly. |
| `plexus-Diagram` | Native `addTool` (6 tools) | None | Already registers 6 native tools via `extensionAPI.ai.addTool` (boards, cards, sections, connections). Already visible to Roam chat and local MCP. |
| `Roam-cursor-smith` | None | None | Pure UI / visual caret overlay (`Roam Caret`); no graph data or workflow an AI agent needs to drive. |
| `svy-theme` | None | None | Pure CSS theme and dark-mode signal bridge; no agent actions needed. |
| `roam-margin-notes` | None | None | Pure layout gesture (`block-view-type: "side"`). No custom data model or checked write invariant beyond standard block view type. |
| `roam-hide-done` | None | None | Pure client-side visual filter (`HIDEDONE`/`SHOWDONE`); no graph state an agent needs to inspect or mutate. |
| `roam-live-ai-toolkit` | None | None | Wraps interactive Live AI Assistant prompts (Explain Block, Daily Summary, Lori Review) for humans; calling an LLM extension from an AI agent is redundant. |
| `roam-auto-attribute` | None | None | Retired extension (2026-08-24, per `roam-plugin-dev` rule 20); do not add new surface area. |
| `roam-cost-meter` | None (template stub) | None (until implemented) | Repo is currently an unimplemented `roam-extension-template` copy (`src/feature.js`). Revisit once cost-metering logic exists (a read-only `cm_report` tool could make sense later). |
| `roam-fragment-queue` | None (template stub) | None (until implemented) | Repo is currently an unimplemented `roam-extension-template` copy (`src/feature.js`). Once built, read/triage queue tools will likely be a strong candidate. |
| `roam-tool-hub` | Native `addTool` (5 hub tools) | None | The hub itself; must not re-expose its own tools via `window.RoamExtensionTools`. |
| `roam-extension-template` | N/A | None | Starter template repo, not an installed extension. |
| `roam-docs` | N/A | None | Documentation mirror (`roamdocs.fyi`), not a Roam extension. |
| `roam-js-extensions` | N/A | None | Frozen legacy `roam/js` catalog (`roam-js-final`), not an active Depot extension. |

## Recommended rollout order (after Svy approves)

1. **`roam-attr-charts`** and **`roam-timeblock-organizer`** — highest day-to-day agent payoff (structured numeric time series and parsed daily schedule/conflicts).
2. **`roam-compass`** and **`roam-hq`** — graph neighborhood synthesis and safe HQ replica tracking.
3. **`roam-archive-todos`**, **`roam-plexus`**, and **`roam-t3-code`** — targeted read/archive helpers.
4. Optional metadata polish on **`roam-grid`** and **`better-tasks`** (`description`, `group`, and `context?.tokenUserUid` pass-through on async writes).
