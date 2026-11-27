import { MAX_GUIDE_CHARS } from "./constants.js";
import { truncateText } from "./registry.js";
import { isExtensionEnabled, isExtensionWriteEnabled } from "./settings.js";

export { MAX_GUIDE_CHARS };
export const FIND_TOOL_NAME = "find_extension_tools";
export const NATIVE_KEY_PREFIX = "native:";
export const DEFAULT_LOAD_LIMIT = 8;
export const MAX_LOAD_LIMIT = 15;
export const MAX_PRELOAD = 6;
export const MAX_CHAT_DESCRIPTION_CHARS = 1800;
export const PRELOAD_MIN_SCORE = 5.5;
export const PRELOAD_RELATIVE_SCORE = 0.55;

const MAX_SHORT_DESCRIPTION_CHARS = 300;
const MAX_SUMMARY_CHARS = 140;
const MAX_INDEX_NAMES_PER_EXTENSION = 40;
const MAX_INDEX_NAMES_TOTAL = 160;
const MAX_QUERY_TOKENS = 60;
const CHAT_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HUB_SIGNATURE_NAMES = ["list_extensions", "describe_tools", "run_read_tool"];
const COMPANION_NAME_TOKENS = new Map([["search", 2], ["list", 2], ["find", 2], ["get", 1], ["read", 1]]);
// Words that say what to do but not what to do it to. They help order tools inside one
// extension and count for little when deciding whether an extension is relevant at all.
const GENERIC_TOKENS = new Set([
  "list", "get", "create", "add", "set", "delete", "remove", "find", "search", "update", "modify",
  "insert", "apply", "return", "read", "write", "change", "edit", "open", "run", "name", "value",
  "text", "item", "thing", "first", "last", "next", "current", "today", "day",
]);
const GENERIC_TOKEN_WEIGHT = 0.4;

// Names Roam's own chat uses or may use. A hub tool never takes one of these.
export const ROAM_CHAT_TOOL_NAMES = Object.freeze([
  "get_block", "get_page", "get_backlinks", "search", "get_comments",
  "search_templates", "roam_query", "datalog_query", "get_open_windows", "get_selection",
  "suggest_links", "semantic_search", "file_get",
  "create_page", "create_block", "append_to_daily_note", "update_block", "delete_block",
  "move_block", "add_comment", "delete_page", "update_page", "open_main_window",
  "open_sidebar", "add_shortcut", "remove_shortcut", "file_delete",
  "web_search", "get_graph_guidelines", "call_extension_tool", "file_upload",
]);

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "can", "use",
  "all", "any", "not", "but", "via", "one", "new", "please", "want", "need", "make", "show", "give",
  "tell", "what", "which", "how", "when", "where", "there", "have", "has", "some", "then", "them",
  "they", "their", "about", "also", "just", "like", "would", "should", "could", "its", "out", "who",
  "was", "were", "will", "does", "did", "our", "her", "his", "him", "she", "here", "each", "every",
  "more", "most", "than", "roam", "block", "blocks", "page", "pages", "graph", "uid", "tool", "tools",
]);

/** What Roam's per-turn tool list says this chat may do. */
export function deriveChatAccess(roamToolNames) {
  const names = new Set(Array.isArray(roamToolNames) ? roamToolNames : []);
  if (names.has("update_block")) return "edit";
  if (names.has("create_block")) return "append";
  return "read";
}

function isToolAllowed(tool, access) {
  return tool.readOnly || access !== "read";
}

function sanitizeNamePart(text) {
  return String(text ?? "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

function lastPathSegment(text) {
  const cleaned = String(text ?? "").replace(/\/+$/, "");
  return cleaned.slice(cleaned.lastIndexOf("/") + 1) || cleaned;
}

function nativeDisplayName(extensionId) {
  const words = lastPathSegment(extensionId)
    .replace(/^roam[-_]/i, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1));
  return words.join(" ") || String(extensionId);
}

function firstSentence(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  const match = clean.match(/^.+?[.!?](?=\s|$)/);
  return match ? match[0] : clean;
}

/**
 * Groups Roam's native `extensionAPI.ai` tools (the `extensionTools` list from
 * `data.ai.getGraphGuidelines`) into the same record shape the registry reader produces.
 * Tool Hub's own five native tools are left out.
 */
export function readNativeExtensions(rawTools) {
  const groups = new Map();
  for (const raw of Array.isArray(rawTools) ? rawTools : []) {
    const id = typeof raw?.tool === "string" ? raw.tool.trim() : "";
    if (!id) continue;
    const extensionId = typeof raw.extension === "string" && raw.extension
      ? raw.extension
      : id.slice(0, Math.max(0, id.lastIndexOf("/")));
    const name = (id.startsWith(extensionId) ? id.slice(extensionId.length) : lastPathSegment(id))
      .replace(/^\/+/, "");
    if (!name || !extensionId) continue;
    if (!groups.has(extensionId)) groups.set(extensionId, []);
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const parameters = raw.inputSchema && typeof raw.inputSchema === "object" && !Array.isArray(raw.inputSchema)
      ? raw.inputSchema
      : { type: "object", properties: {} };
    groups.get(extensionId).push({
      id,
      name,
      description,
      shortDescription: truncateText(description, MAX_SHORT_DESCRIPTION_CHARS),
      readOnly: raw.scope === "read",
      scope: typeof raw.scope === "string" ? raw.scope : "edit",
      parameters,
      native: true,
    });
  }

  const extensions = [];
  for (const [extensionId, tools] of groups) {
    const names = new Set(tools.map((tool) => tool.name));
    if (HUB_SIGNATURE_NAMES.every((name) => names.has(name))) continue;
    const key = `${NATIVE_KEY_PREFIX}${extensionId}`;
    const name = nativeDisplayName(extensionId);
    for (const tool of tools) {
      tool.extensionKey = key;
      tool.extensionName = name;
    }
    const readCount = tools.filter((tool) => tool.readOnly).length;
    const sentences = [];
    for (const tool of tools) {
      const sentence = firstSentence(tool.description);
      if (sentence && !sentences.includes(sentence)) sentences.push(sentence);
      if (sentences.length >= 2) break;
    }
    extensions.push({
      key,
      name,
      version: null,
      group: null,
      native: true,
      guide: "",
      summary: truncateText(sentences.join(" ") || `Tools: ${tools.map((t) => t.name).join(", ")}`, MAX_SUMMARY_CHARS),
      tools,
      toolCount: tools.length,
      readCount,
      writeCount: tools.length - readCount,
    });
  }
  extensions.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key));
  return extensions;
}

function normalizeToken(token) {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenize(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    const token = normalizeToken(raw);
    if (STOP_WORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function tokensMatch(a, b) {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return false;
  let common = 0;
  while (common < shorter && a.charCodeAt(common) === b.charCodeAt(common)) common += 1;
  return common >= Math.max(4, shorter - 1);
}

function buildSearchIndex(tools) {
  const docs = tools.map((tool) => {
    const fields = [
      { weight: 3, tokens: tokenize(`${tool.name} ${tool.chatName}`.replace(/[_-]+/g, " ")) },
      { weight: 2.5, tokens: tokenize(tool.extensionName) },
      { weight: 1, tokens: tokenize(Object.keys(tool.parameters?.properties ?? {}).join(" ").replace(/[_-]+/g, " ")) },
      { weight: 1, tokens: tokenize(tool.description) },
    ];
    return { tool, fields };
  });
  const documentFrequency = new Map();
  for (const doc of docs) {
    const seen = new Set();
    for (const field of doc.fields) for (const token of field.tokens) seen.add(token);
    for (const token of seen) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const total = Math.max(1, docs.length);
  const idf = (token) => Math.log(1 + total / (documentFrequency.get(token) ?? total));
  return { docs, idf };
}

/** Scores every catalog tool against free text. Highest first; zero scores dropped. */
export function rankTools(catalog, text) {
  const queryTokens = tokenize(text).slice(0, MAX_QUERY_TOKENS);
  if (queryTokens.length === 0) return [];
  const { docs, idf } = catalog.searchIndex;
  const ranked = [];
  for (const doc of docs) {
    let score = 0;
    for (const queryToken of queryTokens) {
      let best = 0;
      for (const field of doc.fields) {
        for (const token of field.tokens) {
          if (!tokensMatch(queryToken, token)) continue;
          const value = idf(token) * field.weight;
          if (value > best) best = value;
        }
      }
      score += GENERIC_TOKENS.has(queryToken) ? best * GENERIC_TOKEN_WEIGHT : best;
    }
    if (score > 0) ranked.push({ tool: doc.tool, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.tool.order - b.tool.order);
  return ranked;
}

function assignChatNames(tools, reservedNames) {
  const used = new Set(reservedNames);
  for (const tool of tools) {
    const base = sanitizeNamePart(tool.name).slice(0, 64);
    let candidate = base;
    if (!CHAT_TOOL_NAME_RE.test(candidate) || used.has(candidate)) {
      const prefix = sanitizeNamePart(
        tool.native ? lastPathSegment(tool.extensionKey.slice(NATIVE_KEY_PREFIX.length)) : tool.extensionKey,
      ) || "ext";
      candidate = `${prefix}__${base || "tool"}`.slice(0, 64);
    }
    let unique = candidate;
    for (let n = 2; used.has(unique) || !CHAT_TOOL_NAME_RE.test(unique); n += 1) {
      const suffix = `_${n}`;
      unique = `${candidate.slice(0, 64 - suffix.length)}${suffix}`;
      if (n > 999) break;
    }
    used.add(unique);
    tool.chatName = unique;
  }
}

function cloneSchema(parameters) {
  let schema;
  try {
    schema = JSON.parse(JSON.stringify(parameters ?? {}));
  } catch {
    schema = {};
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) schema = {};
  if (schema.type !== "object") schema.type = "object";
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    schema.properties = {};
  }
  return schema;
}

/**
 * Builds what the chat may see: one entry per tool of every switched-on extension.
 * Writing tools are included only when that extension's writing switch is on.
 */
export function buildChatCatalog({
  registryExtensions = [],
  nativeExtensions = [],
  extensionAPI,
  reservedNames = [],
} = {}) {
  const extensions = [];
  const tools = [];
  for (const ext of [...registryExtensions, ...nativeExtensions]) {
    if (!ext || !Array.isArray(ext.tools)) continue;
    if (!isExtensionEnabled(extensionAPI, ext.key)) continue;
    const writeEnabled = isExtensionWriteEnabled(extensionAPI, ext.key);
    const visible = ext.tools.filter((tool) => tool.readOnly || writeEnabled);
    if (visible.length === 0) continue;
    const record = {
      key: ext.key,
      name: ext.name,
      native: ext.native === true,
      summary: ext.summary || "",
      guide: truncateText(typeof ext.guide === "string" ? ext.guide : "", MAX_GUIDE_CHARS),
      writeEnabled,
      hiddenWriteCount: ext.tools.length - visible.length,
      tools: [],
    };
    for (const tool of visible) {
      const entry = {
        id: tool.id,
        name: tool.name,
        chatName: "",
        native: ext.native === true,
        extensionKey: ext.key,
        extensionName: ext.name,
        description: tool.description || "",
        shortDescription: tool.shortDescription || truncateText(tool.description || "", MAX_SHORT_DESCRIPTION_CHARS),
        readOnly: tool.readOnly === true,
        parameters: cloneSchema(tool.parameters),
        order: tools.length,
      };
      record.tools.push(entry);
      tools.push(entry);
    }
    extensions.push(record);
  }

  assignChatNames(tools, [FIND_TOOL_NAME, ...ROAM_CHAT_TOOL_NAMES, ...reservedNames]);

  const byName = new Map(tools.map((tool) => [tool.chatName, tool]));
  const aliases = new Map();
  for (const tool of tools) {
    aliases.set(tool.id, tool);
    if (!aliases.has(tool.name)) aliases.set(tool.name, tool);
  }
  const signature = JSON.stringify(extensions.map((ext) => [
    ext.key,
    ext.name,
    ext.summary,
    ext.guide,
    ext.hiddenWriteCount,
    ext.tools.map((tool) => [tool.chatName, tool.id, tool.readOnly, tool.description, tool.parameters]),
  ]));

  return {
    extensions,
    tools,
    byName,
    aliases,
    signature,
    searchIndex: buildSearchIndex(tools),
  };
}

export function emptyChatCatalog() {
  return buildChatCatalog({});
}

/** The always-on prompt section: which extensions exist and what their tools are called. */
export function renderIndexSection(catalog, { access = "edit", loadedNames = [] } = {}) {
  const extensions = catalog.extensions
    .map((ext) => ({ ext, tools: ext.tools.filter((tool) => isToolAllowed(tool, access)) }))
    .filter((row) => row.tools.length > 0);
  if (extensions.length === 0) return undefined;

  const total = extensions.reduce((sum, row) => sum + row.tools.length, 0);
  const perExtension = total > MAX_INDEX_NAMES_TOTAL
    ? Math.max(6, Math.floor(MAX_INDEX_NAMES_TOTAL / extensions.length))
    : MAX_INDEX_NAMES_PER_EXTENSION;

  const lines = [
    "Extension tools. The person installed these Roam extensions and switched their tools on for you. They are supplied Roam tools, part of your normal toolset here, not outside apps or plugins.",
    "",
  ];
  for (const { ext, tools } of extensions) {
    const shown = tools.slice(0, perExtension).map((tool) => (tool.readOnly ? tool.chatName : `${tool.chatName}*`));
    const more = tools.length - shown.length;
    lines.push(`- ${ext.name}: ${ext.summary}`.trimEnd());
    lines.push(`  Tools: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`);
  }
  lines.push("");
  lines.push("A name marked * changes the graph.");
  lines.push(
    "When a request touches something one of these extensions manages, use its tools; do not write its block format by hand and do not tell the person to do it in the extension's own interface.",
  );
  lines.push(
    `A tool that is already in your tool list can be called directly. To use any other, first call ${FIND_TOOL_NAME} with its names from the lists above, or with a few words describing the task; the tools are then added to your tool list for your next step.`,
  );
  if (access === "read") lines.push("This chat is read-only, so only tools that read are listed.");

  const loaded = new Set(loadedNames);
  const guides = [];
  for (const { ext, tools } of extensions) {
    if (ext.guide && tools.some((tool) => loaded.has(tool.chatName))) guides.push(`${ext.name}: ${ext.guide}`);
  }
  if (guides.length > 0) {
    lines.push("");
    lines.push("Notes from the extensions whose tools you have loaded:");
    for (const guide of guides.slice(0, 4)) lines.push(`- ${guide}`);
  }
  return lines.join("\n");
}

function extensionMatches(tool, filter) {
  const needle = String(filter ?? "").trim().toLowerCase();
  if (!needle) return true;
  return tool.extensionKey.toLowerCase().includes(needle) || tool.extensionName.toLowerCase().includes(needle);
}

/**
 * Tools worth putting in front of the model before it asks, judged from the person's own words.
 * Returns nothing unless at least one tool matches clearly.
 */
export function suggestTools(catalog, text, { access = "edit", exclude = [], max = MAX_PRELOAD } = {}) {
  const skip = new Set(exclude);
  const ranked = rankTools(catalog, text).filter((row) => isToolAllowed(row.tool, access));
  if (ranked.length === 0 || ranked[0].score < PRELOAD_MIN_SCORE) return [];
  const floor = Math.max(PRELOAD_MIN_SCORE, ranked[0].score * PRELOAD_RELATIVE_SCORE);
  const primary = ranked.filter((row) => row.score >= floor).slice(0, Math.max(1, max - 2)).map((row) => row.tool);

  const picked = [...primary];
  const pickedNames = new Set(picked.map((tool) => tool.chatName));
  const scoreByName = new Map(ranked.map((row) => [row.tool.chatName, row.score]));
  for (const extensionKey of new Set(primary.map((tool) => tool.extensionKey))) {
    if (picked.length >= max) break;
    // One tool to locate things (search or list), then the best-matching other read tool.
    const candidates = catalog.tools
      .filter((tool) => tool.extensionKey === extensionKey && tool.readOnly && !pickedNames.has(tool.chatName))
      .map((tool) => ({
        tool,
        rank: Math.max(0, ...tool.name.toLowerCase().split(/[^a-z0-9]+/).map((token) => COMPANION_NAME_TOKENS.get(token) ?? 0)),
      }))
      .filter((row) => row.rank > 0);
    const locator = candidates.filter((row) => row.rank === 2).sort((a, b) => a.tool.order - b.tool.order)[0];
    const rest = candidates
      .filter((row) => row !== locator)
      .sort((a, b) => (scoreByName.get(b.tool.chatName) ?? 0) - (scoreByName.get(a.tool.chatName) ?? 0) || a.tool.order - b.tool.order);
    const companions = [locator, rest[0]].filter(Boolean).map((row) => row.tool);
    for (const tool of companions) {
      if (picked.length >= max) break;
      picked.push(tool);
      pickedNames.add(tool.chatName);
    }
  }
  return picked.filter((tool) => !skip.has(tool.chatName));
}

/**
 * The `find_extension_tools` tool body. Returns what the model reads (`payload`) and the
 * chat tool names to load (`load`).
 */
export function findExtensionTools(args, { catalog, access = "edit", guidesSent = new Set() } = {}) {
  const requestedNames = Array.isArray(args?.names)
    ? args.names.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim())
    : [];
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  const extension = typeof args?.extension === "string" ? args.extension.trim() : "";
  const rawLimit = Number.isInteger(args?.limit) ? args.limit : DEFAULT_LOAD_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LOAD_LIMIT, rawLimit));

  const selected = [];
  const notLoaded = [];
  let totalMatched = 0;

  if (requestedNames.length > 0) {
    for (const rawName of requestedNames.slice(0, MAX_LOAD_LIMIT)) {
      const name = rawName.replace(/\*$/, "");
      const tool = catalog.byName.get(name) ?? catalog.aliases.get(name);
      if (!tool) {
        notLoaded.push({ name: rawName, reason: "No such tool. Use a name from the extension tools list." });
      } else if (!isToolAllowed(tool, access)) {
        notLoaded.push({ name: tool.chatName, reason: "This chat is read-only and that tool changes the graph." });
      } else if (!selected.includes(tool)) {
        selected.push(tool);
      }
    }
    totalMatched = selected.length;
  } else {
    let candidates;
    if (query) {
      candidates = rankTools(catalog, query).map((row) => row.tool);
      if (candidates.length === 0) {
        const needle = query.toLowerCase();
        candidates = catalog.tools.filter((tool) => (
          `${tool.chatName} ${tool.extensionName} ${tool.description}`.toLowerCase().includes(needle)
        ));
      }
    } else {
      candidates = [...catalog.tools];
    }
    candidates = candidates.filter((tool) => extensionMatches(tool, extension) && isToolAllowed(tool, access));
    totalMatched = candidates.length;
    selected.push(...candidates.slice(0, limit));
  }

  const guides = {};
  for (const tool of selected) {
    const ext = catalog.extensions.find((row) => row.key === tool.extensionKey);
    if (ext?.guide && !guidesSent.has(ext.key)) {
      guides[ext.name] = ext.guide;
      guidesSent.add(ext.key);
    }
  }

  const payload = {
    loaded: selected.map((tool) => tool.chatName),
    tools: selected.map((tool) => ({
      name: tool.chatName,
      extension: tool.extensionName,
      changes_graph: !tool.readOnly,
      description: tool.shortDescription,
    })),
  };
  if (Object.keys(guides).length > 0) payload.guides = guides;
  if (notLoaded.length > 0) payload.not_loaded = notLoaded;
  if (totalMatched > selected.length) {
    payload.more = `${totalMatched - selected.length} more matched. Narrow the query, name an extension, or pass exact names.`;
  }
  payload.note = selected.length > 0
    ? "These tools are in your tool list from your next step, with their full parameters. Call them directly."
    : `Nothing matched. Extensions available: ${catalog.extensions.map((ext) => ext.name).join(", ") || "none"}.`;

  return { payload, load: selected.map((tool) => tool.chatName) };
}

export const FIND_TOOL_DESCRIPTION =
  "Load tools from the person's installed Roam extensions into your tool list. Pass `names` (exact names from the extension tools list in your instructions) or `query` (a few words about the task), optionally `extension` to stay inside one extension. Returns each loaded tool's description; the tools themselves are callable from your next step.";

export const FIND_TOOL_PARAMETERS = Object.freeze({
  type: "object",
  properties: {
    names: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_LOAD_LIMIT,
      description: "Exact tool names to load.",
    },
    query: { type: "string", description: "A few words about the task, used when you do not know the names." },
    extension: { type: "string", description: "Limit the search to one extension, by name." },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LOAD_LIMIT,
      description: `How many tools a search may load (default ${DEFAULT_LOAD_LIMIT}).`,
    },
  },
  additionalProperties: false,
});
