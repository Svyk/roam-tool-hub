# Tool Hub

A zero-runtime-dependency Roam Depot extension that exposes every tool registered on `window.RoamExtensionTools` to Roam's local AI surfaces (local MCP, CLI, Local API, and Roam's built-in chat once Roam enables `call_extension_tool` in `app-agent.js`) through five small native AI tools—without loading dozens of tool schemas into every session.

## Registered AI tools

Tool Hub registers five tools via `extensionAPI.ai.addTool`:

| Tool | Scope | Purpose |
|---|---|---|
| `list_extensions` | `read` | One row per enabled extension (`key`, `name`, `toolCount`, `readCount`, `writeCount`, `writeEnabled`, one-line `summary`). |
| `find_tools` | `read` | Filter enabled tools by `extension`, `query`, and `limit` (1–100, default 25). Descriptions truncated to 300 chars; no schemas. |
| `describe_tools` | `read` | Full descriptions and parameter schemas for 1–5 tool ids (`<extKey>/<toolName>`). |
| `run_read_tool` | `read` | Run one read-only tool (`readOnly: true` and not `isMutating: true`). |
| `run_tool` | `edit` | Run one enabled tool of any kind; non-read-only tools require the extension's **allow writing tools** switch to be enabled. |

Agents discover tools in order: `list_extensions` or `find_tools` → `describe_tools` → `run_read_tool` or `run_tool`.

## Safety and attribution

- **Read-only isolation**: `run_read_tool` is registered with `scope: "read"` and refuses any tool without `readOnly: true` (or with `isMutating: true`). `run_tool` is registered with `scope: "edit"`, so Roam blocks it on read-only AI connections before the handler runs. Note: `run_read_tool` relies on each registry tool honestly marking `readOnly: true` (Roam's read-only token scope blocks synchronous writes, whereas a mislabeled tool writing after an `await` runs with the logged-in session).
- **Per-extension defaults**: Newly discovered extensions default to **expose tools: ON** (read-only tools enabled) and **allow writing tools: OFF**. Turning an extension off hides it from discovery and blocks execution.
- **Argument validation**: Before calling `tool.execute`, arguments are validated against the tool's `parameters` using a built-in draft-07 subset (`type`, `required`, `properties`, `items`, `enum`, `minimum`, `maximum`, `minItems`, `maxItems`, `minLength`, `maxLength`, `additionalProperties`). Unknown keywords pass silently.
- **Result size cap**: Thrown errors and rejected promises are caught and returned as `{ tool, code, error }`. Serialized results above 40,000 characters are truncated with `truncated: true`, `originalChars`, `maxChars`, and a note.
- **Write attribution limit**: Tool Hub invokes registry tools via `context.asTokenUser(() => tool.execute(args, context))` and awaits the returned value outside `asTokenUser`. Per Roam's `extensionAPI.ai` contract, synchronous writes issued before the tool's first `await` are attributed to the AI user; writes made after a tool's first `await` are attributed to the logged-in user unless the target tool uses the passed `context.tokenUserUid` (`user-uid`). This is a known limit of the `window.RoamExtensionTools` convention.
- **Zero typing overhead**: Tool Hub registers no `keydown` listeners, no polling timers, and at most one command palette entry (`Tool Hub: Refresh registry & settings`). The registry is re-read on demand when a tool or refresh runs.
- **Optional guidelines index**: Enable **Publish index on roam/agent guidelines** in Settings to maintain one generated summary block on `[[roam/agent guidelines]]` (upserted by stored block UID, written only when text changes, never touching other blocks). Above 20 enabled extensions, it writes grouped counts and points to `list_extensions`. Turning the setting off deletes that block; unloading the extension leaves it intact so reloads do not churn the page. Default is OFF so graphs are not modified until opted in.

## Commands

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run dev              # initial build, then rebuild on src/ changes
npm run build            # generate root and deploy artifacts
npm test                 # node:test suite
npm run scan:secrets     # fail on common committed credentials
npm run verify:generated # verify root and deploy/ artifacts match src/
npm run check            # build, secret scan, syntax check, tests, artifact check
```

## Install as a Developer Extension

In Roam: **Settings → Roam Depot → enable Developer mode → Developer Extensions → Load extension → URL**, and enter the public GitHub Pages root URL (`https://OWNER.github.io/roam-tool-hub`, without `/extension.js`).

Developer extensions are installed per client and do not sync across devices. Reload with `Ctrl-D`, then `Ctrl-R`. If an open tab keeps running an old bundle (`window.__ROAM_TOOL_HUB_VERSION`), remove and re-add that exact URL entry instead of hard-reloading an encrypted graph.

## License

[MIT](LICENSE)
