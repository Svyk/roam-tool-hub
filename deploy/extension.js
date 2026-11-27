/* Tool Hub v0.4.1 | MIT | generated; edit src/ */

// src/constants.js
var HUB_VERSION = "0.4.1";
var LOG_PREFIX = "[roam-tool-hub]";
var RUNTIME_VERSION_KEY = "__ROAM_TOOL_HUB_VERSION";
var MAX_TOOL_DESCRIPTION_CHARS = 300;
var MAX_SUMMARY_CHARS = 140;
var MAX_DESCRIBE_TOOLS = 5;
var DEFAULT_FIND_LIMIT = 25;
var MAX_FIND_LIMIT = 100;
var MAX_RESULT_CHARS = 4e4;
var MAX_GUIDE_CHARS = 900;
var GUIDELINES_PAGE_TITLE = "roam/agent guidelines";
var GUIDELINES_SUMMARY_THRESHOLD = 20;
var SETTING_IDS = Object.freeze({
  refreshButton: "refresh-extensions",
  guidelinesEnabled: "guidelines-index-enabled",
  guidelinesBlockUid: "guidelines-block-uid",
  chatBridgeEnabled: "chat-bridge-enabled",
  chatAutoLoad: "chat-auto-load"
});

// src/registry.js
function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
function safeSlice(text, maxChars) {
  if (typeof text !== "string" || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 55296 && lastCode <= 56319) {
    end -= 1;
  }
  return text.slice(0, end);
}
function truncateText(text, maxChars) {
  const clean = collapseWhitespace(text);
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 1) return safeSlice(clean, maxChars);
  return `${safeSlice(clean, maxChars - 1)}…`;
}
function firstSentence(text) {
  const clean = collapseWhitespace(text);
  if (!clean) return "";
  const match = clean.match(/^.+?[.!?](?=\s|$)/);
  return match ? match[0] : clean;
}
function deriveExtensionSummary(ext, tools) {
  if (typeof ext?.description === "string" && ext.description.trim()) {
    return truncateText(ext.description, MAX_SUMMARY_CHARS);
  }
  if (tools.length === 0) return "No callable tools.";
  if (tools.length === 1) {
    const desc = firstSentence(tools[0].description);
    return truncateText(desc || tools[0].name, MAX_SUMMARY_CHARS);
  }
  const snippets = [];
  for (const tool of tools) {
    const sentence = firstSentence(tool.description);
    if (sentence && !snippets.includes(sentence)) {
      snippets.push(sentence);
      if (snippets.length >= 2) break;
    }
  }
  if (snippets.length === 0) {
    return truncateText(`Tools: ${tools.slice(0, 4).map((t) => t.name).join(", ")}`, MAX_SUMMARY_CHARS);
  }
  return truncateText(snippets.join(" "), MAX_SUMMARY_CHARS);
}
function isToolReadOnly(rawTool) {
  return rawTool?.readOnly === true && rawTool?.isMutating !== true;
}
function defaultRegistryGetter() {
  if (typeof globalThis.window !== "undefined" && globalThis.window.RoamExtensionTools) {
    return globalThis.window.RoamExtensionTools;
  }
  if (globalThis.RoamExtensionTools) {
    return globalThis.RoamExtensionTools;
  }
  return {};
}
function readRegistrySnapshot(getRegistry = defaultRegistryGetter) {
  let rawRegistry;
  try {
    rawRegistry = typeof getRegistry === "function" ? getRegistry() : getRegistry;
  } catch {
    rawRegistry = null;
  }
  if (!rawRegistry || typeof rawRegistry !== "object") {
    return { extensions: [], byKey: /* @__PURE__ */ new Map(), toolsById: /* @__PURE__ */ new Map() };
  }
  const extensions = [];
  const byKey = /* @__PURE__ */ new Map();
  const toolsById = /* @__PURE__ */ new Map();
  for (const [extKey, ext] of Object.entries(rawRegistry)) {
    if (!extKey || extKey.includes("/") || !ext || typeof ext !== "object" || !Array.isArray(ext.tools)) continue;
    const name = collapseWhitespace(ext.name) || extKey;
    const version = collapseWhitespace(ext.version) || null;
    const group = collapseWhitespace(ext.group) || null;
    const seenNames = /* @__PURE__ */ new Set();
    const tools = [];
    for (const rawTool of ext.tools) {
      if (!rawTool || typeof rawTool !== "object") continue;
      if (typeof rawTool.name !== "string") continue;
      const toolName = rawTool.name.trim();
      if (!toolName || toolName.includes("/")) continue;
      if (typeof rawTool.execute !== "function") continue;
      if (seenNames.has(toolName)) continue;
      seenNames.add(toolName);
      const id = `${extKey}/${toolName}`;
      const description = typeof rawTool.description === "string" ? rawTool.description.trim() : "";
      const parameters = rawTool.parameters && typeof rawTool.parameters === "object" && !Array.isArray(rawTool.parameters) ? rawTool.parameters : { type: "object", properties: {} };
      const normalizedTool = {
        id,
        extensionKey: extKey,
        extensionName: name,
        name: toolName,
        description,
        shortDescription: truncateText(description, MAX_TOOL_DESCRIPTION_CHARS),
        readOnly: isToolReadOnly(rawTool),
        parameters,
        execute: (args, context) => rawTool.execute(args, context)
      };
      tools.push(normalizedTool);
      toolsById.set(id, normalizedTool);
    }
    if (tools.length === 0) continue;
    const readCount = tools.filter((t) => t.readOnly).length;
    const writeCount = tools.length - readCount;
    const summary = deriveExtensionSummary(ext, tools);
    const guide = typeof ext.guide === "string" && ext.guide.trim() ? truncateText(ext.guide, MAX_GUIDE_CHARS) : "";
    const record = {
      key: extKey,
      name,
      version,
      group,
      summary,
      guide,
      tools,
      toolCount: tools.length,
      readCount,
      writeCount
    };
    extensions.push(record);
    byKey.set(extKey, record);
  }
  extensions.sort((a, b) => a.name.localeCompare(b.name, void 0, { sensitivity: "base" }) || a.key.localeCompare(b.key));
  return { extensions, byKey, toolsById };
}

// src/settings.js
function encodeSettingKeySegment(raw) {
  return String(raw).replace(/[~.#$[\]/\x00-\x1f\x7f]/g, (ch) => `~${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
function extensionEnabledSettingId(extKey) {
  return `ext:${encodeSettingKeySegment(extKey)}:enabled`;
}
function extensionWriteSettingId(extKey) {
  return `ext:${encodeSettingKeySegment(extKey)}:write`;
}
function extensionChatAutoSettingId(extKey) {
  return `ext:${encodeSettingKeySegment(extKey)}:chat-auto`;
}
function isExtensionEnabled(extensionAPI, extKey) {
  const value = extensionAPI?.settings?.get?.(extensionEnabledSettingId(extKey));
  return value === null || value === void 0 ? true : Boolean(value);
}
function isExtensionWriteEnabled(extensionAPI, extKey) {
  const value = extensionAPI?.settings?.get?.(extensionWriteSettingId(extKey));
  return value === null || value === void 0 ? false : Boolean(value);
}
function isGuidelinesIndexEnabled(extensionAPI) {
  const value = extensionAPI?.settings?.get?.(SETTING_IDS.guidelinesEnabled);
  return value === true;
}
function isChatBridgeEnabled(extensionAPI) {
  return extensionAPI?.settings?.get?.(SETTING_IDS.chatBridgeEnabled) === true;
}
function isChatAutoLoadEnabled(extensionAPI) {
  return extensionAPI?.settings?.get?.(SETTING_IDS.chatAutoLoad) !== false;
}
function isChatAutoApproved(extensionAPI, extKey) {
  return extensionAPI?.settings?.get?.(extensionChatAutoSettingId(extKey)) === true;
}
function describeChatBridgeStatus(status) {
  switch (status?.phase) {
    case "waiting":
      return "On. Roam's assistant has not loaded in this window yet; open the AI chat once.";
    case "starting":
      return "On. Starting.";
    case "ready":
      return "On. Attaches at the next chat turn.";
    case "attached": {
      const tools = Number(status.tools) || 0;
      const extensions = Number(status.extensions) || 0;
      const base = `On and attached: ${tools} tool${tools === 1 ? "" : "s"} from ${extensions} extension${extensions === 1 ? "" : "s"}.`;
      return status.verified === true ? `${base} Confirmed in a chat turn.` : base;
    }
    case "failed":
      return `Turned itself off: ${status.detail || "unknown reason"}.`;
    default:
      return "Off.";
  }
}
function getGuidelinesBlockUid(extensionAPI) {
  const value = extensionAPI?.settings?.get?.(SETTING_IDS.guidelinesBlockUid);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
async function setGuidelinesBlockUid(extensionAPI, uid) {
  if (extensionAPI?.settings?.canSet === false) return;
  await extensionAPI?.settings?.set?.(SETTING_IDS.guidelinesBlockUid, uid || null);
}
async function seedExtensionDefaults(extensionAPI, extensions) {
  if (extensionAPI?.settings?.canSet === false) return;
  if (extensionAPI.settings.get(SETTING_IDS.guidelinesEnabled) == null) {
    await extensionAPI.settings.set(SETTING_IDS.guidelinesEnabled, false);
  }
  if (extensionAPI.settings.get(SETTING_IDS.chatBridgeEnabled) == null) {
    await extensionAPI.settings.set(SETTING_IDS.chatBridgeEnabled, false);
  }
  if (extensionAPI.settings.get(SETTING_IDS.chatAutoLoad) == null) {
    await extensionAPI.settings.set(SETTING_IDS.chatAutoLoad, true);
  }
  for (const ext of extensions) {
    const enabledId = extensionEnabledSettingId(ext.key);
    if (extensionAPI.settings.get(enabledId) == null) {
      await extensionAPI.settings.set(enabledId, true);
    }
    const writeId = extensionWriteSettingId(ext.key);
    if (extensionAPI.settings.get(writeId) == null) {
      await extensionAPI.settings.set(writeId, false);
    }
    const chatAutoId = extensionChatAutoSettingId(ext.key);
    if (extensionAPI.settings.get(chatAutoId) == null) {
      await extensionAPI.settings.set(chatAutoId, false);
    }
  }
}
function createSettingsPanel({
  extensions = [],
  nativeExtensions = [],
  chatStatus,
  onRefresh,
  onToggleExtension,
  onToggleGuidelines,
  onToggleChatBridge,
  onToggleChatAutoLoad
} = {}) {
  const settings = [
    {
      id: SETTING_IDS.refreshButton,
      name: "Refresh discovered extensions",
      description: extensions.length ? `Currently seeing ${extensions.length} extension${extensions.length === 1 ? "" : "s"} in window.RoamExtensionTools.` : "No extensions found in window.RoamExtensionTools yet. Click Refresh after other extensions finish loading.",
      action: {
        type: "button",
        content: "Refresh",
        onClick: () => {
          void onRefresh?.();
        }
      }
    },
    {
      id: SETTING_IDS.guidelinesEnabled,
      name: "Publish index on roam/agent guidelines",
      description: "Maintain one generated Tool Hub summary block on [[roam/agent guidelines]] for Local MCP clients (scoped so built-in Cmd-J ignores it). Click Refresh to sync late-loading extensions. Turning this off removes that block.",
      action: {
        type: "switch",
        onChange: (event) => {
          void onToggleGuidelines?.(Boolean(event?.target?.checked));
        }
      }
    },
    {
      id: SETTING_IDS.chatBridgeEnabled,
      name: "Built-in chat bridge (experimental)",
      description: `Let Roam's own AI chat (Cmd-J, Ask AI) use these extensions' tools. Uses an undocumented part of Roam and turns itself off if Roam changes it. Status: ${describeChatBridgeStatus(chatStatus)}`,
      action: {
        type: "switch",
        onChange: (event) => {
          void onToggleChatBridge?.(Boolean(event?.target?.checked));
        }
      }
    },
    {
      id: SETTING_IDS.chatAutoLoad,
      name: "Chat: load matching tools automatically",
      description: "Before each chat turn, put the tools that match your message in front of the model so it does not have to look for them.",
      action: {
        type: "switch",
        onChange: (event) => {
          void onToggleChatAutoLoad?.(Boolean(event?.target?.checked));
        }
      }
    }
  ];
  const chatAutoRow = (ext, name, description) => ({
    id: extensionChatAutoSettingId(ext.key),
    name: `${name} — chat may change the graph without asking`,
    description,
    action: {
      type: "switch",
      onChange: (event) => {
        void onToggleExtension?.(ext.key, "chatAuto", Boolean(event?.target?.checked));
      }
    }
  });
  for (const ext of extensions) {
    const counts = `${ext.toolCount} tool${ext.toolCount === 1 ? "" : "s"} (${ext.readCount} read, ${ext.writeCount} write)`;
    settings.push({
      id: extensionEnabledSettingId(ext.key),
      name: `${ext.name} — expose tools`,
      description: `Allow AI surfaces to discover and run read-only tools from ${ext.key} (${counts}).`,
      action: {
        type: "switch",
        onChange: (event) => {
          void onToggleExtension?.(ext.key, "enabled", Boolean(event?.target?.checked));
        }
      }
    });
    settings.push({
      id: extensionWriteSettingId(ext.key),
      name: `${ext.name} — allow writing tools`,
      description: ext.writeCount > 0 ? `Allow run_tool to invoke ${ext.writeCount} non-read-only tool${ext.writeCount === 1 ? "" : "s"} from ${ext.key}. Default off.` : `Allow run_tool to invoke non-read-only tools from ${ext.key} if any are added later. Default off.`,
      action: {
        type: "switch",
        onChange: (event) => {
          void onToggleExtension?.(ext.key, "write", Boolean(event?.target?.checked));
        }
      }
    });
    if (ext.writeCount > 0) {
      settings.push(chatAutoRow(
        ext,
        ext.name,
        `Skip the confirm dialog when the built-in chat runs a writing tool from ${ext.key}. Tools that delete, or change things in bulk, still ask. Default off.`
      ));
    }
  }
  for (const ext of nativeExtensions) {
    const counts = `${ext.toolCount} tool${ext.toolCount === 1 ? "" : "s"} (${ext.readCount} read, ${ext.writeCount} write)`;
    const label = `${ext.name} (native AI tools)`;
    settings.push({
      id: extensionEnabledSettingId(ext.key),
      name: `${label} — expose tools`,
      description: `Allow the built-in chat bridge to offer read-only tools from ${ext.key} (${counts}). The switch applies to the built-in chat bridge only, since MCP clients already see native tools directly.`,
      action: {
        type: "switch",
        onChange: (event) => {
          void onToggleExtension?.(ext.key, "enabled", Boolean(event?.target?.checked));
        }
      }
    });
    settings.push({
      id: extensionWriteSettingId(ext.key),
      name: `${label} — allow writing tools`,
      description: `Allow the built-in chat bridge to offer ${ext.writeCount} non-read-only tool${ext.writeCount === 1 ? "" : "s"} from ${ext.key}. The switch applies to the built-in chat bridge only, since MCP clients already see native tools directly. Default off.`,
      action: {
        type: "switch",
        onChange: (event) => {
          void onToggleExtension?.(ext.key, "write", Boolean(event?.target?.checked));
        }
      }
    });
    if (ext.writeCount > 0) {
      settings.push(chatAutoRow(
        ext,
        label,
        `Skip the confirm dialog when the built-in chat runs a writing tool from ${ext.key}. Tools that delete, or change things in bulk, still ask. The switch applies to the built-in chat bridge only, since MCP clients already see native tools directly. Default off.`
      ));
    }
  }
  return {
    tabTitle: "Tool Hub",
    settings
  };
}

// src/chat-catalog.js
var FIND_TOOL_NAME = "find_extension_tools";
var NATIVE_KEY_PREFIX = "native:";
var DEFAULT_LOAD_LIMIT = 8;
var MAX_LOAD_LIMIT = 15;
var MAX_PRELOAD = 6;
var MAX_CHAT_DESCRIPTION_CHARS = 1800;
var PRELOAD_MIN_SCORE = 5.5;
var PRELOAD_RELATIVE_SCORE = 0.55;
var MAX_SHORT_DESCRIPTION_CHARS = 300;
var MAX_SUMMARY_CHARS2 = 140;
var MAX_INDEX_NAMES_PER_EXTENSION = 40;
var MAX_INDEX_NAMES_TOTAL = 160;
var MAX_QUERY_TOKENS = 120;
var MAX_QUERY_HEAD_TOKENS = 50;
var MAX_QUERY_TAIL_TOKENS = MAX_QUERY_TOKENS - MAX_QUERY_HEAD_TOKENS;
var CHAT_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
var HUB_SIGNATURE_NAMES = ["list_extensions", "describe_tools", "run_read_tool"];
var COMPANION_NAME_TOKENS = /* @__PURE__ */ new Map([["search", 2], ["list", 2], ["find", 2], ["get", 1], ["read", 1]]);
var QUERY_ALIASES = /* @__PURE__ */ new Map([
  ["whiteboard", ["board"]],
  ["spreadsheet", ["table", "grid"]],
  ["datagrid", ["grid"]],
  ["subtask", ["task"]],
  ["todo", ["task"]]
]);
var DESTRUCTIVE_NAME_TOKENS = /* @__PURE__ */ new Set([
  "delete",
  "remove",
  "clear",
  "drop",
  "destroy",
  "purge",
  "wipe",
  "reset",
  "restore",
  "archive",
  "bulk"
]);
var NOT_OFFERED_REASON = "Not available in this turn. Ask again in your next message.";
var GENERIC_TOKENS = /* @__PURE__ */ new Set([
  "list",
  "get",
  "create",
  "add",
  "set",
  "delete",
  "remove",
  "find",
  "search",
  "update",
  "modify",
  "insert",
  "apply",
  "return",
  "read",
  "write",
  "change",
  "edit",
  "open",
  "run",
  "export",
  "name",
  "value",
  "text",
  "item",
  "thing",
  "first",
  "last",
  "next",
  "current",
  "today",
  "day",
  "detailed",
  "detail",
  "suggest",
  "suggestion",
  "manage",
  "summary"
]);
var GENERIC_TOKEN_WEIGHT = 0.4;
var ROAM_CHAT_TOOL_NAMES = Object.freeze([
  "get_block",
  "get_page",
  "get_backlinks",
  "search",
  "get_comments",
  "search_templates",
  "roam_query",
  "datalog_query",
  "get_open_windows",
  "get_selection",
  "suggest_links",
  "semantic_search",
  "file_get",
  "create_page",
  "create_block",
  "append_to_daily_note",
  "update_block",
  "delete_block",
  "move_block",
  "add_comment",
  "delete_page",
  "update_page",
  "open_main_window",
  "open_sidebar",
  "add_shortcut",
  "remove_shortcut",
  "file_delete",
  "web_search",
  "get_graph_guidelines",
  "call_extension_tool",
  "file_upload"
]);
var STOP_WORDS = /* @__PURE__ */ new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "you",
  "are",
  "can",
  "use",
  "all",
  "any",
  "not",
  "but",
  "via",
  "one",
  "new",
  "please",
  "want",
  "need",
  "make",
  "show",
  "give",
  "tell",
  "what",
  "which",
  "how",
  "when",
  "where",
  "there",
  "have",
  "has",
  "some",
  "then",
  "them",
  "they",
  "their",
  "about",
  "also",
  "just",
  "like",
  "would",
  "should",
  "could",
  "its",
  "out",
  "who",
  "was",
  "were",
  "will",
  "does",
  "did",
  "our",
  "her",
  "his",
  "him",
  "she",
  "here",
  "each",
  "every",
  "more",
  "most",
  "than",
  "roam",
  "block",
  "blocks",
  "page",
  "pages",
  "graph",
  "uid",
  "tool",
  "tools"
]);
function deriveChatAccess(roamToolNames) {
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
  const words = lastPathSegment(extensionId).replace(/^roam[-_]/i, "").split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1));
  return words.join(" ") || String(extensionId);
}
function firstSentence2(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  const match = clean.match(/^.+?[.!?](?=\s|$)/);
  return match ? match[0] : clean;
}
function readNativeExtensions(rawTools) {
  const groups = /* @__PURE__ */ new Map();
  for (const raw of Array.isArray(rawTools) ? rawTools : []) {
    const id = typeof raw?.tool === "string" ? raw.tool.trim() : "";
    if (!id) continue;
    const extensionId = typeof raw.extension === "string" && raw.extension ? raw.extension : id.slice(0, Math.max(0, id.lastIndexOf("/")));
    const name = (id.startsWith(extensionId) ? id.slice(extensionId.length) : lastPathSegment(id)).replace(/^\/+/, "");
    if (!name || !extensionId) continue;
    if (!groups.has(extensionId)) groups.set(extensionId, []);
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const parameters = raw.inputSchema && typeof raw.inputSchema === "object" && !Array.isArray(raw.inputSchema) ? raw.inputSchema : { type: "object", properties: {} };
    groups.get(extensionId).push({
      id,
      name,
      description,
      shortDescription: truncateText(description, MAX_SHORT_DESCRIPTION_CHARS),
      readOnly: raw.scope === "read",
      scope: typeof raw.scope === "string" ? raw.scope : "edit",
      parameters,
      native: true
    });
  }
  const extensions = [];
  for (const [extensionId, tools] of groups) {
    const names = new Set(tools.map((tool) => tool.name));
    if (HUB_SIGNATURE_NAMES.every((name2) => names.has(name2))) continue;
    const key = `${NATIVE_KEY_PREFIX}${extensionId}`;
    const name = nativeDisplayName(extensionId);
    for (const tool of tools) {
      tool.extensionKey = key;
      tool.extensionName = name;
    }
    const readCount = tools.filter((tool) => tool.readOnly).length;
    const sentences = [];
    for (const tool of tools) {
      const sentence = firstSentence2(tool.description);
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
      summary: truncateText(sentences.join(" ") || `Tools: ${tools.map((t) => t.name).join(", ")}`, MAX_SUMMARY_CHARS2),
      tools,
      toolCount: tools.length,
      readCount,
      writeCount: tools.length - readCount
    });
  }
  extensions.sort((a, b) => a.name.localeCompare(b.name, void 0, { sensitivity: "base" }) || a.key.localeCompare(b.key));
  return extensions;
}
function normalizeToken(token) {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}
function tokenize(text) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    const token = normalizeToken(raw);
    if (STOP_WORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}
function isDestructiveToolName(name) {
  return String(name ?? "").toLowerCase().split(/[^a-z0-9]+/).some((token) => DESTRUCTIVE_NAME_TOKENS.has(token));
}
function tokensMatch(queryToken, docToken) {
  if (queryToken === docToken) return true;
  const shorter = Math.min(queryToken.length, docToken.length);
  if (shorter < 4) return false;
  let common = 0;
  while (common < shorter && queryToken.charCodeAt(common) === docToken.charCodeAt(common)) common += 1;
  return common >= Math.max(4, shorter - 1);
}
function buildSearchIndex(tools) {
  const docs = tools.map((tool) => {
    const fields = [
      { weight: 3, tokens: tokenize(`${tool.name} ${tool.chatName}`.replace(/[_-]+/g, " ")) },
      { weight: 2.5, tokens: tokenize(tool.extensionName) },
      { weight: 1, tokens: tokenize(Object.keys(tool.parameters?.properties ?? {}).join(" ").replace(/[_-]+/g, " ")) },
      { weight: 1, tokens: tokenize(tool.description) }
    ];
    return { tool, fields };
  });
  const documentFrequency = /* @__PURE__ */ new Map();
  for (const doc of docs) {
    const seen = /* @__PURE__ */ new Set();
    for (const field of doc.fields) for (const token of field.tokens) seen.add(token);
    for (const token of seen) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const total = Math.max(1, docs.length);
  const idf = (token) => Math.log(1 + total / (documentFrequency.get(token) ?? total));
  return { docs, idf };
}
function rankTools(catalog, text) {
  const allTokens = tokenize(text);
  if (allTokens.length === 0) return [];
  const queryTokens = allTokens.length <= MAX_QUERY_TOKENS ? allTokens : [...allTokens.slice(0, MAX_QUERY_HEAD_TOKENS), ...allTokens.slice(-MAX_QUERY_TAIL_TOKENS)];
  const { docs, idf } = catalog.searchIndex;
  const ranked = [];
  for (const doc of docs) {
    let score = 0;
    let specific = false;
    for (const queryToken of queryTokens) {
      const aliases = QUERY_ALIASES.get(queryToken);
      let best = 0;
      let bestSpecific = false;
      for (const field of doc.fields) {
        for (const token of field.tokens) {
          if (tokensMatch(queryToken, token)) {
            const generic = GENERIC_TOKENS.has(queryToken) || GENERIC_TOKENS.has(token);
            const value = idf(token) * field.weight * (generic ? GENERIC_TOKEN_WEIGHT : 1);
            if (value > best) {
              best = value;
              bestSpecific = !generic;
            }
          }
          if (aliases) {
            for (const alias of aliases) {
              if (!tokensMatch(alias, token)) continue;
              const value = idf(token) * field.weight;
              if (value > best) {
                best = value;
                bestSpecific = true;
              }
            }
          }
        }
      }
      score += best;
      if (bestSpecific) specific = true;
    }
    if (score > 0) ranked.push({ tool: doc.tool, score, specific });
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
        tool.native ? lastPathSegment(tool.extensionKey.slice(NATIVE_KEY_PREFIX.length)) : tool.extensionKey
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
function buildChatCatalog({
  registryExtensions = [],
  nativeExtensions = [],
  extensionAPI,
  reservedNames = []
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
      tools: []
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
        destructive: isDestructiveToolName(tool.name),
        parameters: cloneSchema(tool.parameters),
        order: tools.length
      };
      record.tools.push(entry);
      tools.push(entry);
    }
    extensions.push(record);
  }
  assignChatNames(tools, [FIND_TOOL_NAME, ...ROAM_CHAT_TOOL_NAMES, ...reservedNames]);
  const byName = new Map(tools.map((tool) => [tool.chatName, tool]));
  const aliases = /* @__PURE__ */ new Map();
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
    ext.tools.map((tool) => [tool.chatName, tool.id, tool.readOnly, tool.destructive, tool.description, tool.parameters])
  ]));
  return {
    extensions,
    tools,
    byName,
    aliases,
    signature,
    searchIndex: buildSearchIndex(tools)
  };
}
function emptyChatCatalog() {
  return buildChatCatalog({});
}
function renderIndexSection(catalog, { access = "edit", loadedNames = [] } = {}) {
  const extensions = catalog.extensions.map((ext) => ({ ext, tools: ext.tools.filter((tool) => isToolAllowed(tool, access)) })).filter((row) => row.tools.length > 0);
  if (extensions.length === 0) return void 0;
  const total = extensions.reduce((sum, row) => sum + row.tools.length, 0);
  const perExtension = total > MAX_INDEX_NAMES_TOTAL ? Math.max(6, Math.floor(MAX_INDEX_NAMES_TOTAL / extensions.length)) : MAX_INDEX_NAMES_PER_EXTENSION;
  const lines = [
    "Extension tools. The person installed these Roam extensions and switched their tools on for you. They are supplied Roam tools, part of your normal toolset here, not outside apps or plugins.",
    ""
  ];
  for (const { ext, tools } of extensions) {
    const shown = tools.slice(0, perExtension).map((tool) => tool.readOnly ? tool.chatName : `${tool.chatName}*`);
    const more = tools.length - shown.length;
    lines.push(`- ${ext.name}: ${ext.summary}`.trimEnd());
    lines.push(`  Tools: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`);
  }
  lines.push("");
  lines.push("A name marked * changes the graph.");
  lines.push(
    "When a request touches something one of these extensions manages, use its tools; do not write its block format by hand and do not tell the person to do it in the extension's own interface."
  );
  lines.push(
    `A tool that is already in your tool list can be called directly. To use any other, first call ${FIND_TOOL_NAME} with its names from the lists above, or with a few words describing the task; the tools are then added to your tool list for your next step.`
  );
  lines.push(
    "Tools are put in your list by matching words in the person's message, so a tool being there does not mean it is wanted. Use one only when the request is really about what that extension manages."
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
function companionRank(tool) {
  const lower = tool.name.toLowerCase();
  if (lower.includes("template")) return 0;
  return Math.max(0, ...lower.split(/[^a-z0-9]+/).map((token) => COMPANION_NAME_TOKENS.get(token) ?? 0));
}
function suggestTools(catalog, text, { access = "edit", exclude = [], max = MAX_PRELOAD } = {}) {
  const skip = new Set(exclude);
  const allRanked = rankTools(catalog, text);
  const ranked = allRanked.filter((row) => isToolAllowed(row.tool, access) && row.specific);
  if (ranked.length === 0 || ranked[0].score < PRELOAD_MIN_SCORE) return [];
  const floor = Math.max(PRELOAD_MIN_SCORE, ranked[0].score * PRELOAD_RELATIVE_SCORE);
  const primary = ranked.filter((row) => row.score >= floor).slice(0, Math.max(1, max - 2)).map((row) => row.tool);
  const picked = [...primary];
  const pickedNames = new Set(picked.map((tool) => tool.chatName));
  const scoreByName = new Map(allRanked.map((row) => [row.tool.chatName, row.score]));
  for (const extensionKey of new Set(primary.map((tool) => tool.extensionKey))) {
    if (picked.length >= max) break;
    const present = catalog.tools.filter((tool) => tool.extensionKey === extensionKey && tool.readOnly && (pickedNames.has(tool.chatName) || skip.has(tool.chatName)));
    const hasLocator = present.some((tool) => companionRank(tool) === 2);
    const hasReader = present.some((tool) => companionRank(tool) === 1);
    const candidates = catalog.tools.filter((tool) => tool.extensionKey === extensionKey && tool.readOnly && !pickedNames.has(tool.chatName) && !skip.has(tool.chatName)).map((tool) => ({ tool, rank: companionRank(tool) })).filter((row) => row.rank > 0);
    const locator = hasLocator ? null : candidates.filter((row) => row.rank === 2).sort((a, b) => (scoreByName.get(b.tool.chatName) ?? 0) - (scoreByName.get(a.tool.chatName) ?? 0) || a.tool.order - b.tool.order)[0];
    const reader = hasReader ? null : candidates.filter((row) => row.rank === 1 && row !== locator).sort((a, b) => (scoreByName.get(b.tool.chatName) ?? 0) - (scoreByName.get(a.tool.chatName) ?? 0) || a.tool.order - b.tool.order)[0];
    for (const row of [locator, reader]) {
      if (!row || picked.length >= max) continue;
      picked.push(row.tool);
      pickedNames.add(row.tool.chatName);
    }
  }
  return picked.filter((tool) => !skip.has(tool.chatName));
}
function findExtensionTools(args, { catalog, access = "edit", guidesSent = /* @__PURE__ */ new Set(), offered = null } = {}) {
  const requestedNames = Array.isArray(args?.names) ? args.names.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim()) : [];
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  const extension = typeof args?.extension === "string" ? args.extension.trim() : "";
  const rawLimit = Number.isInteger(args?.limit) ? args.limit : DEFAULT_LOAD_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LOAD_LIMIT, rawLimit));
  const offeredSet = offered instanceof Set ? offered : Array.isArray(offered) ? new Set(offered) : null;
  const selected = [];
  const notLoaded = [];
  let totalMatched = 0;
  let consideredCount = 0;
  if (requestedNames.length > 0) {
    for (const rawName of requestedNames.slice(0, MAX_LOAD_LIMIT)) {
      const name = rawName.replace(/\*$/, "");
      const tool = catalog.byName.get(name) ?? catalog.aliases.get(name);
      if (!tool) {
        notLoaded.push({ name: rawName, reason: "No such tool. Use a name from the extension tools list." });
      } else if (!isToolAllowed(tool, access)) {
        notLoaded.push({ name: tool.chatName, reason: "This chat is read-only and that tool changes the graph." });
      } else if (offeredSet && !offeredSet.has(tool.chatName)) {
        if (!notLoaded.some((row) => row.name === tool.chatName)) {
          notLoaded.push({ name: tool.chatName, reason: NOT_OFFERED_REASON });
        }
      } else if (!selected.includes(tool)) {
        selected.push(tool);
      }
    }
    totalMatched = selected.length;
    consideredCount = selected.length;
  } else {
    let candidates;
    if (query) {
      candidates = rankTools(catalog, query).map((row) => row.tool);
      if (candidates.length === 0) {
        const needle = query.toLowerCase();
        candidates = catalog.tools.filter((tool) => `${tool.chatName} ${tool.extensionName} ${tool.description}`.toLowerCase().includes(needle));
      }
    } else {
      candidates = [...catalog.tools];
    }
    candidates = candidates.filter((tool) => extensionMatches(tool, extension) && isToolAllowed(tool, access));
    totalMatched = candidates.length;
    const considered = candidates.slice(0, limit);
    consideredCount = considered.length;
    for (const tool of considered) {
      if (offeredSet && !offeredSet.has(tool.chatName)) {
        notLoaded.push({ name: tool.chatName, reason: NOT_OFFERED_REASON });
      } else {
        selected.push(tool);
      }
    }
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
      description: tool.shortDescription
    }))
  };
  if (Object.keys(guides).length > 0) payload.guides = guides;
  if (notLoaded.length > 0) payload.not_loaded = notLoaded;
  if (totalMatched > consideredCount) {
    payload.more = `${totalMatched - consideredCount} more matched. Narrow the query, name an extension, or pass exact names.`;
  }
  payload.note = selected.length > 0 ? "These tools are in your tool list from your next step, with their full parameters. Call them directly." : notLoaded.length > 0 ? "No tools were loaded in this turn. See not_loaded for details." : `Nothing matched. Extensions available: ${catalog.extensions.map((ext) => ext.name).join(", ") || "none"}.`;
  return { payload, load: selected.map((tool) => tool.chatName) };
}
var FIND_TOOL_DESCRIPTION = "Load tools from the person's installed Roam extensions into your tool list. Pass `names` (exact names from the extension tools list in your instructions) or `query` (a few words about the task), optionally `extension` to stay inside one extension. Returns each loaded tool's description; the tools themselves are callable from your next step.";
var FIND_TOOL_PARAMETERS = Object.freeze({
  type: "object",
  properties: {
    names: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_LOAD_LIMIT,
      description: "Exact tool names to load."
    },
    query: { type: "string", description: "A few words about the task, used when you do not know the names." },
    extension: { type: "string", description: "Limit the search to one extension, by name." },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LOAD_LIMIT,
      description: `How many tools a search may load (default ${DEFAULT_LOAD_LIMIT}).`
    }
  },
  additionalProperties: false
});

// src/schema-validator.js
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
var MAX_VALIDATION_DEPTH = 64;
function deepEqual(a, b, depth = 0, seenA = null) {
  if (a === b) return true;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (depth >= MAX_VALIDATION_DEPTH) return false;
  const active = seenA || /* @__PURE__ */ new Set();
  if (active.has(a)) return false;
  active.add(a);
  try {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (!deepEqual(a[i], b[i], depth + 1, active)) return false;
      }
      return true;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key], depth + 1, active)) return false;
    }
    return true;
  } finally {
    active.delete(a);
  }
}
function matchesSingleType(value, expectedType) {
  switch (expectedType) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      return true;
  }
}
function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (typeof value === "object" && !isPlainObject(value)) {
    return value.constructor?.name || "object";
  }
  return typeof value;
}
function validateNode(value, schema, path, errors, visitingSchemas, depth) {
  if (schema === void 0 || schema === null || schema === true) return;
  if (schema === false) {
    errors.push(`${path}: value is disallowed by schema`);
    return;
  }
  if (typeof schema !== "object" || Array.isArray(schema)) return;
  if (depth >= MAX_VALIDATION_DEPTH || visitingSchemas.has(schema)) return;
  visitingSchemas.add(schema);
  try {
    if (schema.type !== void 0) {
      const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
      const ok = allowed.some((typeName) => matchesSingleType(value, typeName));
      if (!ok) {
        errors.push(`${path}: expected ${allowed.join(" or ")}, got ${describeType(value)}`);
        return;
      }
    }
    if (Array.isArray(schema.enum)) {
      const inEnum = schema.enum.some((candidate) => deepEqual(value, candidate));
      if (!inEnum) {
        const rendered = schema.enum.map((item) => {
          try {
            return JSON.stringify(item);
          } catch {
            return String(item);
          }
        }).join(", ");
        errors.push(`${path}: must be one of [${rendered}]`);
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        errors.push(`${path}: must be >= ${schema.minimum}`);
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        errors.push(`${path}: must be <= ${schema.maximum}`);
      }
    }
    if (typeof value === "string") {
      const length = [...value].length;
      if (typeof schema.minLength === "number" && length < schema.minLength) {
        errors.push(`${path}: length must be >= ${schema.minLength}`);
      }
      if (typeof schema.maxLength === "number" && length > schema.maxLength) {
        errors.push(`${path}: length must be <= ${schema.maxLength}`);
      }
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        errors.push(`${path}: must have at least ${schema.minItems} item(s)`);
      }
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
        errors.push(`${path}: must have at most ${schema.maxItems} item(s)`);
      }
      if (schema.items !== void 0) {
        if (Array.isArray(schema.items)) {
          const limit = Math.min(value.length, schema.items.length);
          for (let i = 0; i < limit; i += 1) {
            validateNode(value[i], schema.items[i], `${path}[${i}]`, errors, visitingSchemas, depth + 1);
          }
        } else if (typeof schema.items === "object" || typeof schema.items === "boolean") {
          for (let i = 0; i < value.length; i += 1) {
            validateNode(value[i], schema.items, `${path}[${i}]`, errors, visitingSchemas, depth + 1);
          }
        }
      }
    }
    if (isPlainObject(value)) {
      if (Array.isArray(schema.required)) {
        for (const reqKey of schema.required) {
          if (typeof reqKey !== "string") continue;
          if (!Object.prototype.hasOwnProperty.call(value, reqKey) || value[reqKey] === void 0) {
            errors.push(`${path}: missing required property "${reqKey}"`);
          }
        }
      }
      const properties = isPlainObject(schema.properties) ? schema.properties : null;
      const hasPatternProps = isPlainObject(schema.patternProperties) && Object.keys(schema.patternProperties).length > 0;
      for (const [key, propValue] of Object.entries(value)) {
        const childPath = path === "$" ? `$.${key}` : `${path}.${key}`;
        if (properties && Object.prototype.hasOwnProperty.call(properties, key)) {
          validateNode(propValue, properties[key], childPath, errors, visitingSchemas, depth + 1);
        } else if (hasPatternProps) {
        } else if (schema.additionalProperties === false) {
          errors.push(`${childPath}: additional property is not allowed`);
        } else if (isPlainObject(schema.additionalProperties)) {
          validateNode(propValue, schema.additionalProperties, childPath, errors, visitingSchemas, depth + 1);
        }
      }
    }
  } finally {
    visitingSchemas.delete(schema);
  }
}
function validateAgainstSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, "$", errors, /* @__PURE__ */ new Set(), 0);
  return { valid: errors.length === 0, errors };
}

// src/hub-tools.js
var HUB_TOOL_NAMES = Object.freeze([
  "list_extensions",
  "find_tools",
  "describe_tools",
  "run_read_tool",
  "run_tool"
]);
function formatError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function buildTruncatedEnvelope(toolId, serialized, previewLen, maxChars) {
  const preview = safeSlice(serialized, previewLen);
  return {
    tool: toolId,
    truncated: true,
    originalChars: serialized.length,
    maxChars,
    note: `Result truncated from ${serialized.length} to ${preview.length} characters.`,
    resultPreview: preview
  };
}
function finalizeToolResult(toolId, rawResult, maxChars = MAX_RESULT_CHARS) {
  const normalized = rawResult === void 0 ? null : rawResult;
  let serialized;
  try {
    serialized = JSON.stringify(normalized);
  } catch (error) {
    return {
      tool: toolId,
      code: "serialization-error",
      error: `Tool "${toolId}" returned a non-JSON-serializable value: ${formatError(error)}`
    };
  }
  if (serialized === void 0) {
    return { tool: toolId, result: null };
  }
  const fullEnvelope = { tool: toolId, result: normalized };
  if (JSON.stringify(fullEnvelope).length <= maxChars) {
    return fullEnvelope;
  }
  const emptyEnvelope = buildTruncatedEnvelope(toolId, serialized, 0, maxChars);
  if (JSON.stringify(emptyEnvelope).length > maxChars) {
    return buildTruncatedEnvelope(toolId, serialized, Math.max(0, maxChars), maxChars);
  }
  let lo = 0;
  let hi = Math.min(serialized.length, maxChars);
  let best = emptyEnvelope;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = buildTruncatedEnvelope(toolId, serialized, mid, maxChars);
    if (JSON.stringify(candidate).length <= maxChars) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
async function invokeWithAttribution(tool, args, context) {
  let pending;
  if (typeof context?.asTokenUser === "function") {
    pending = context.asTokenUser(() => tool.execute(args, context));
  } else {
    pending = tool.execute(args, context);
  }
  return await pending;
}
function matchesQuery(tool, query) {
  const tokens = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = [
    tool.id,
    tool.name,
    tool.extensionKey,
    tool.extensionName,
    tool.description
  ].join(" ").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}
function matchesExtensionFilter(ext, filter) {
  const needle = String(filter ?? "").trim().toLowerCase();
  if (!needle) return true;
  return ext.key.toLowerCase().includes(needle) || ext.name.toLowerCase().includes(needle);
}
function createHubTools({
  extensionAPI,
  getRegistry = defaultRegistryGetter,
  maxResultChars = MAX_RESULT_CHARS,
  onSnapshot
} = {}) {
  function getFreshSnapshot() {
    const snapshot = readRegistrySnapshot(getRegistry);
    try {
      onSnapshot?.(snapshot);
    } catch {
    }
    return snapshot;
  }
  function enabledExtensions(snapshot) {
    return snapshot.extensions.filter((ext) => isExtensionEnabled(extensionAPI, ext.key));
  }
  async function executeRegistryTool(args, context, { readOnlyOnly }) {
    const toolId = typeof args?.tool === "string" ? args.tool.trim() : "";
    if (!toolId) {
      return { tool: toolId, code: "invalid-tool-id", error: "tool id (<extKey>/<toolName>) is required." };
    }
    const snapshot = getFreshSnapshot();
    const tool = snapshot.toolsById.get(toolId);
    if (!tool) {
      return {
        tool: toolId,
        code: "tool-not-found",
        error: `Tool "${toolId}" was not found. Call list_extensions or find_tools to see available tools.`
      };
    }
    if (!isExtensionEnabled(extensionAPI, tool.extensionKey)) {
      return {
        tool: toolId,
        code: "extension-disabled",
        error: `Extension "${tool.extensionName}" (${tool.extensionKey}) is disabled in Tool Hub settings.`
      };
    }
    if (readOnlyOnly && !tool.readOnly) {
      return {
        tool: toolId,
        code: "read-only-required",
        error: `Tool "${toolId}" is not marked readOnly: true and cannot run through run_read_tool. Use run_tool on an edit-scoped connection if writing tools are allowed for ${tool.extensionKey}.`
      };
    }
    if (!readOnlyOnly && !tool.readOnly && !isExtensionWriteEnabled(extensionAPI, tool.extensionKey)) {
      return {
        tool: toolId,
        code: "write-disabled",
        error: `Writing tools are disabled for "${tool.extensionName}" (${tool.extensionKey}). Enable "${tool.extensionName} — allow writing tools" in Tool Hub settings to run "${toolId}".`
      };
    }
    const toolArgs = args?.args === void 0 ? {} : args.args;
    if (!isPlainObject(toolArgs)) {
      return {
        tool: toolId,
        code: "validation-failed",
        error: `Invalid arguments for "${toolId}": args must be a plain object.`
      };
    }
    let validation;
    try {
      validation = validateAgainstSchema(toolArgs, tool.parameters);
    } catch (error) {
      return {
        tool: toolId,
        code: "schema-error",
        error: `Parameter schema for "${toolId}" could not be validated: ${formatError(error)}`
      };
    }
    if (!validation.valid) {
      return {
        tool: toolId,
        code: "validation-failed",
        error: `Arguments failed schema validation for "${toolId}": ${validation.errors.join("; ")}`,
        validationErrors: validation.errors
      };
    }
    try {
      const rawResult = await invokeWithAttribution(tool, toolArgs, context);
      return finalizeToolResult(toolId, rawResult, maxResultChars);
    } catch (error) {
      return {
        tool: toolId,
        code: "execution-error",
        error: `Tool "${toolId}" threw an error: ${formatError(error)}`
      };
    }
  }
  const list_extensions = {
    name: "list_extensions",
    scope: "read",
    description: "List enabled extensions in window.RoamExtensionTools with tool counts and summaries. Start here or with find_tools, then call describe_tools before running a tool.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    handler() {
      const snapshot = getFreshSnapshot();
      const enabled = enabledExtensions(snapshot);
      let totalTools = 0;
      const extensions = enabled.map((ext) => {
        totalTools += ext.toolCount;
        const row = {
          key: ext.key,
          name: ext.name,
          toolCount: ext.toolCount,
          readCount: ext.readCount,
          writeCount: ext.writeCount,
          writeEnabled: isExtensionWriteEnabled(extensionAPI, ext.key),
          summary: ext.summary
        };
        if (ext.version) row.version = ext.version;
        if (ext.guide) row.guide = ext.guide;
        return row;
      });
      return {
        extensions,
        totalExtensions: extensions.length,
        totalTools
      };
    }
  };
  const find_tools = {
    name: "find_tools",
    scope: "read",
    description: "Search enabled extension tools by extension or query (no schemas). Call describe_tools on 1-5 returned ids before calling run_read_tool or run_tool.",
    inputSchema: {
      type: "object",
      properties: {
        extension: {
          type: "string",
          description: "Optional extension key or name substring filter."
        },
        query: {
          type: "string",
          description: "Optional keywords matched against tool id, name, description, and extension."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_FIND_LIMIT,
          description: `Max tools to return (1-${MAX_FIND_LIMIT}, default ${DEFAULT_FIND_LIMIT}).`
        }
      },
      additionalProperties: false
    },
    handler(args = {}) {
      const snapshot = getFreshSnapshot();
      const enabled = enabledExtensions(snapshot);
      const rawLimit = args?.limit;
      const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(MAX_FIND_LIMIT, rawLimit)) : DEFAULT_FIND_LIMIT;
      const matched = [];
      for (const ext of enabled) {
        if (args?.extension && !matchesExtensionFilter(ext, args.extension)) continue;
        const writeEnabled = isExtensionWriteEnabled(extensionAPI, ext.key);
        for (const tool of ext.tools) {
          if (args?.query && !matchesQuery(tool, args.query)) continue;
          matched.push({
            id: tool.id,
            extension: ext.key,
            extensionName: ext.name,
            name: tool.name,
            description: tool.shortDescription,
            readOnly: tool.readOnly,
            writeEnabled
          });
        }
      }
      const slice = matched.slice(0, limit);
      const response = {
        tools: slice,
        totalMatched: matched.length,
        truncated: matched.length > slice.length
      };
      const guides = {};
      for (const row of slice) {
        const ext = enabled.find((candidate) => candidate.key === row.extension);
        if (ext?.guide) guides[ext.key] = ext.guide;
      }
      if (Object.keys(guides).length > 0) response.guides = guides;
      return response;
    }
  };
  const describe_tools = {
    name: "describe_tools",
    scope: "read",
    description: "Return full descriptions and parameter schemas for 1-5 tool ids (<extKey>/<toolName>) from list_extensions or find_tools. Call before run_read_tool or run_tool.",
    inputSchema: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          minItems: 1,
          maxItems: MAX_DESCRIBE_TOOLS,
          items: { type: "string" },
          description: `1 to ${MAX_DESCRIBE_TOOLS} tool ids (<extKey>/<toolName>).`
        }
      },
      required: ["tools"],
      additionalProperties: false
    },
    handler(args = {}) {
      const requested = args?.tools;
      if (!Array.isArray(requested) || requested.length < 1 || requested.length > MAX_DESCRIBE_TOOLS) {
        return {
          error: `tools must be an array of 1 to ${MAX_DESCRIBE_TOOLS} tool ids.`
        };
      }
      const snapshot = getFreshSnapshot();
      const tools = [];
      const errors = [];
      for (const rawId of requested) {
        const id = typeof rawId === "string" ? rawId.trim() : "";
        if (!id) {
          errors.push({ id: String(rawId ?? ""), error: "Tool id must be a non-empty string." });
          continue;
        }
        const tool = snapshot.toolsById.get(id);
        if (!tool) {
          errors.push({ id, error: "Tool not found." });
          continue;
        }
        if (!isExtensionEnabled(extensionAPI, tool.extensionKey)) {
          errors.push({ id, error: `Extension "${tool.extensionName}" (${tool.extensionKey}) is disabled.` });
          continue;
        }
        let safeParameters = tool.parameters;
        try {
          const serialized = JSON.stringify(tool.parameters);
          if (serialized && serialized.length > maxResultChars) {
            safeParameters = {
              _truncated: true,
              note: `Parameter schema exceeded ${maxResultChars} chars and was omitted.`
            };
          }
        } catch {
          safeParameters = {
            _serializationError: true,
            note: "Parameter schema was not JSON-serializable."
          };
        }
        tools.push({
          id: tool.id,
          extension: tool.extensionKey,
          extensionName: tool.extensionName,
          name: tool.name,
          description: tool.description,
          readOnly: tool.readOnly,
          writeEnabled: isExtensionWriteEnabled(extensionAPI, tool.extensionKey),
          parameters: safeParameters
        });
      }
      const response = { tools };
      if (errors.length > 0) response.errors = errors;
      return response;
    }
  };
  const run_read_tool = {
    name: "run_read_tool",
    scope: "read",
    description: "Run one read-only extension tool (<extKey>/<toolName>). Call describe_tools first to inspect its parameters. Refuses non-read-only tools.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Tool id (<extKey>/<toolName>)."
        },
        args: {
          type: "object",
          description: "Tool arguments matching describe_tools parameters."
        }
      },
      required: ["tool"],
      additionalProperties: false
    },
    handler(args, context) {
      return executeRegistryTool(args, context, { readOnlyOnly: true });
    }
  };
  const run_tool = {
    name: "run_tool",
    scope: "edit",
    description: "Run one enabled extension tool (<extKey>/<toolName>), including writing tools when allowed in settings. Call describe_tools first to inspect its parameters.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Tool id (<extKey>/<toolName>)."
        },
        args: {
          type: "object",
          description: "Tool arguments matching describe_tools parameters."
        }
      },
      required: ["tool"],
      additionalProperties: false
    },
    handler(args, context) {
      return executeRegistryTool(args, context, { readOnlyOnly: false });
    }
  };
  return [list_extensions, find_tools, describe_tools, run_read_tool, run_tool];
}
function registerHubTools(extensionAPI, tools) {
  const ai = extensionAPI?.ai;
  if (typeof ai?.addTool !== "function") {
    console.warn(`${LOG_PREFIX} extensionAPI.ai.addTool is unavailable in this Roam version.`);
    return () => {
    };
  }
  const registered = [];
  const removeRegistered = () => {
    for (const name of registered.splice(0).reverse()) {
      try {
        ai.removeTool?.({ name });
      } catch {
      }
    }
  };
  try {
    for (const tool of tools) {
      ai.addTool({
        name: tool.name,
        description: tool.description,
        scope: tool.scope,
        inputSchema: tool.inputSchema,
        handler: tool.handler
      });
      registered.push(tool.name);
    }
  } catch (error) {
    removeRegistered();
    throw error;
  }
  return removeRegistered;
}

// src/chat-bridge.js
var CHAT_BRIDGE_STATE_KEY = "__roamToolHubChatBridge";
var CHAT_EXTENSION_NAME = "tool-hub";
var CHAT_SECTION_KEY = "toolhub";
var RUNTIME_GLOBAL = "PiHarness";
var ROAM_EXTENSION_NAME = "roam";
var ROAM_CHAT_MARKER_TOOLS = ["get_page", "search"];
var NATIVE_TOOLS_TTL_MS = 15e3;
var NATIVE_TOOLS_TIMEOUT_MS = 4e3;
var NATIVE_TOOLS_TURN_WAIT_MS = 1500;
var DISCOVERY_TIMEOUT_MS = 1e4;
var MAX_LOADED_PER_CONVERSATION = 24;
var MAX_TRACKED_CONVERSATIONS = 200;
var MAX_TRACKED_REGISTRIES = 4;
var BLOCK_RUN_UID_RE = /user-authored Roam block with UID `([^`\s]{6,40})`/;
var READ_ONLY_MESSAGE = "This conversation has read-only access to the graph.";
function isPlainObject2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" ? error : String(error);
}
function textResult(value, isError = false) {
  let text;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value ?? null);
    } catch {
      text = String(value);
    }
  }
  return { output: [{ type: "text", text }], details: null, isError };
}
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.type === "text" && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
}
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function waitUpTo(promise, ms) {
  let timer;
  const stop = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, stop]).finally(() => clearTimeout(timer));
}
function checkRuntimeShape(runtime) {
  const durable = runtime?.durable;
  const needed = [
    [durable?.createRegistry, "durable.createRegistry"],
    [durable?.defineExtension, "durable.defineExtension"],
    [durable?.section, "durable.section"],
    [durable?.hook, "durable.hook"],
    [durable?.Harness?.open, "durable.Harness.open"],
    [durable?.MemoryStorage, "durable.MemoryStorage"],
    [runtime?.createModels, "createModels"]
  ];
  for (const [value, label] of needed) {
    if (typeof value !== "function") return `${label} is missing`;
  }
  if (typeof durable.ToolTask?.definition?.name !== "string") return "durable.ToolTask is missing";
  if (durable.BACKGROUND_CONTEXT === void 0 || durable.BACKGROUND_CONTEXT === null) {
    return "durable.BACKGROUND_CONTEXT is missing";
  }
  return null;
}
function pageState(win) {
  let state = win[CHAT_BRIDGE_STATE_KEY];
  if (!state || typeof state !== "object") {
    state = {
      impl: null,
      registries: /* @__PURE__ */ new Set(),
      installed: /* @__PURE__ */ new WeakMap(),
      conversations: /* @__PURE__ */ new Map(),
      patches: null,
      trap: null,
      status: { phase: "off" }
    };
    Object.defineProperty(win, CHAT_BRIDGE_STATE_KEY, {
      value: state,
      configurable: true,
      enumerable: false,
      writable: true
    });
  }
  return state;
}
function createChatBridge({
  windowRef = globalThis.window,
  extensionAPI,
  getRegistrySnapshot,
  getNativeTools: getNativeTools2 = async () => [],
  runRegistryTool,
  callNativeTool,
  confirmWrite,
  isAutoLoadEnabled = () => true,
  isChatAutoApproved: isChatAutoApproved2 = () => false,
  readBlockText: readBlockText2 = () => "",
  onStatus,
  maxResultChars = MAX_RESULT_CHARS,
  nativeToolsTimeoutMs = NATIVE_TOOLS_TIMEOUT_MS,
  nativeToolsTtlMs = NATIVE_TOOLS_TTL_MS,
  nativeToolsTurnWaitMs = NATIVE_TOOLS_TURN_WAIT_MS,
  logger = console
} = {}) {
  const hasWindow = Boolean(windowRef);
  if (!hasWindow) windowRef = {};
  const state = pageState(windowRef);
  const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let attached = false;
  let runtime = null;
  let catalog = emptyChatCatalog();
  let installedNames = /* @__PURE__ */ new Set();
  let refreshing = null;
  let nativeCache = { at: 0, tools: [], ready: false };
  let nativeRefreshing = null;
  const warned = /* @__PURE__ */ new Set();
  const stats = { turns: 0, preloads: 0, finds: 0, calls: 0, blocked: 0, errors: 0 };
  function warnOnce(key, error) {
    stats.errors += 1;
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn?.(`${LOG_PREFIX} Chat bridge: ${key}`, error);
  }
  function setStatus(patch) {
    state.status = {
      ...state.status,
      ...patch,
      tools: catalog.tools.length,
      extensions: catalog.extensions.length,
      registries: state.registries.size,
      // The live counters, not a copy: they keep moving between status changes.
      stats,
      updatedAt: Date.now()
    };
    try {
      onStatus?.(state.status);
    } catch {
    }
  }
  function fail(detail, error) {
    if (error) warnOnce(detail, error);
    setStatus({ phase: "failed", detail });
  }
  function conversationState(id) {
    if (id === void 0 || id === null) {
      return { access: void 0, loaded: /* @__PURE__ */ new Set(), guidesSent: /* @__PURE__ */ new Set(), offered: /* @__PURE__ */ new Set(), approved: /* @__PURE__ */ new Set() };
    }
    let conv = state.conversations.get(id);
    if (conv) {
      state.conversations.delete(id);
      if (!(conv.offered instanceof Set)) conv.offered = /* @__PURE__ */ new Set();
      if (!(conv.approved instanceof Set)) conv.approved = /* @__PURE__ */ new Set();
    } else {
      conv = { access: void 0, loaded: /* @__PURE__ */ new Set(), guidesSent: /* @__PURE__ */ new Set(), offered: /* @__PURE__ */ new Set(), approved: /* @__PURE__ */ new Set(), probed: false };
    }
    state.conversations.set(id, conv);
    while (state.conversations.size > MAX_TRACKED_CONVERSATIONS) {
      state.conversations.delete(state.conversations.keys().next().value);
    }
    return conv;
  }
  function peekConversation(id) {
    return id === void 0 || id === null ? void 0 : state.conversations.get(id);
  }
  function rememberLoaded(conv, names) {
    for (const name of names) {
      conv.loaded.delete(name);
      conv.loaded.add(name);
    }
    while (conv.loaded.size > MAX_LOADED_PER_CONVERSATION) {
      conv.loaded.delete(conv.loaded.values().next().value);
    }
  }
  function applyCatalog(nativeTools, { force = false } = {}) {
    if (!attached) return;
    const snapshot = getRegistrySnapshot();
    const next = buildChatCatalog({
      registryExtensions: snapshot?.extensions ?? [],
      nativeExtensions: readNativeExtensions(nativeTools),
      extensionAPI
    });
    const changed = next.signature !== catalog.signature;
    if (changed) catalog = next;
    if (changed || force) {
      for (const registry of state.registries) installInto(registry);
      setStatus({});
    }
  }
  function fetchNativeTools() {
    if (nativeRefreshing) return nativeRefreshing;
    nativeRefreshing = (async () => {
      try {
        const tools = await withTimeout(
          Promise.resolve().then(() => getNativeTools2()),
          nativeToolsTimeoutMs,
          "Reading native extension tools"
        );
        nativeCache = { tools: Array.isArray(tools) ? tools : [], ready: true, at: Date.now() };
      } catch (error) {
        nativeCache = { tools: nativeCache.tools, ready: nativeCache.ready, at: Date.now() };
        if (attached) warnOnce("native extension tools could not be read", error);
      } finally {
        nativeRefreshing = null;
      }
      return nativeCache.tools;
    })();
    return nativeRefreshing;
  }
  async function readNativeTools(force) {
    if (force) {
      await fetchNativeTools();
      return nativeCache.tools;
    }
    if (!nativeCache.ready) {
      if (!nativeRefreshing && (nativeCache.at === 0 || Date.now() - nativeCache.at >= nativeToolsTtlMs)) {
        void fetchNativeTools();
      }
      if (nativeRefreshing) {
        await waitUpTo(nativeRefreshing, nativeToolsTurnWaitMs);
      }
      return nativeCache.tools;
    }
    if (Date.now() - nativeCache.at >= nativeToolsTtlMs) {
      void fetchNativeTools();
    }
    return nativeCache.tools;
  }
  function refresh({ force = false } = {}) {
    if (!attached) return Promise.resolve();
    if (refreshing) return force ? refreshing.then(() => attached ? refresh({ force }) : void 0) : refreshing;
    refreshing = (async () => {
      const native = await readNativeTools(force);
      if (!attached) return;
      applyCatalog(native, { force });
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }
  async function runFind(args, context) {
    stats.finds += 1;
    const conv = conversationState(context?.conversationId);
    const offered = new Set([...conv.offered].filter((name) => installedNames.has(name)));
    const { payload, load } = findExtensionTools(args, {
      catalog,
      access: conv.access ?? "edit",
      guidesSent: conv.guidesSent,
      offered
    });
    const usable = load.filter((name) => offered.has(name));
    rememberLoaded(conv, usable);
    const result = textResult(payload, false);
    result.details = { found: payload.tools.length };
    if (usable.length > 0) result.control = { addTools: usable };
    return result;
  }
  async function runTool(chatName, args, context) {
    stats.calls += 1;
    const entry = catalog.byName.get(chatName);
    if (!entry) {
      return textResult({ error: `${chatName} is no longer available. Call ${FIND_TOOL_NAME} to see what is.` }, true);
    }
    if (!entry.readOnly && peekConversation(context?.conversationId)?.access === "read") {
      return textResult({ error: READ_ONLY_MESSAGE }, true);
    }
    const toolArgs = isPlainObject2(args) ? args : {};
    let raw;
    try {
      if (entry.native) {
        const response = await callNativeTool(entry.id, toolArgs);
        const value = isPlainObject2(response) && "result" in response ? response.result : response;
        raw = finalizeToolResult(entry.id, value, maxResultChars);
      } else {
        raw = await runRegistryTool(entry.id, toolArgs);
      }
    } catch (error) {
      raw = { tool: entry.id, code: "execution-error", error: errorMessage(error) };
    }
    const failed = isPlainObject2(raw) && typeof raw.error === "string" && typeof raw.code === "string";
    if (failed) return textResult({ error: raw.error, code: raw.code }, true);
    const body = isPlainObject2(raw) && "result" in raw && raw.truncated !== true ? raw.result : raw;
    return textResult(body, false);
  }
  async function beforeTool(call, task, context) {
    const name = call?.name;
    if (typeof name !== "string" || !installedNames.has(name)) return void 0;
    const entry = catalog.byName.get(name);
    if (!entry || entry.readOnly) return void 0;
    try {
      const conv = peekConversation(task?.conversationId ?? context?.conversationId);
      if (conv?.access === "read") {
        stats.blocked += 1;
        return { block: READ_ONLY_MESSAGE };
      }
      const mayRemember = !entry.destructive && Boolean(conv?.access);
      if (mayRemember && (isChatAutoApproved2(entry.extensionKey) || conv.approved?.has(entry.extensionKey))) {
        return void 0;
      }
      if (typeof confirmWrite !== "function") {
        stats.blocked += 1;
        return { block: "Tool Hub has no way to ask the person to confirm this change, so it was not made." };
      }
      const decision = await confirmWrite({
        toolName: entry.chatName,
        toolId: entry.id,
        extensionKey: entry.extensionKey,
        extensionName: entry.extensionName,
        description: entry.shortDescription,
        args: isPlainObject2(call.arguments) ? call.arguments : {},
        allowChat: mayRemember,
        signal: context?.abortSignal ?? task?.signal
      });
      if (decision === "chat" && mayRemember) {
        if (!(conv.approved instanceof Set)) conv.approved = /* @__PURE__ */ new Set();
        conv.approved.add(entry.extensionKey);
        return void 0;
      }
      if (decision === "once") return void 0;
      stats.blocked += 1;
      return { block: "The user rejected this change." };
    } catch (error) {
      warnOnce("confirming a change failed", error);
      stats.blocked += 1;
      return { block: "Tool Hub could not confirm this change with the person, so it was not made." };
    }
  }
  function renderSection(sectionContext) {
    try {
      const conv = peekConversation(sectionContext?.conversationId);
      return renderIndexSection(catalog, {
        access: conv?.access ?? "edit",
        loadedNames: conv ? [...conv.loaded] : []
      });
    } catch (error) {
      warnOnce("rendering the prompt section failed", error);
      return void 0;
    }
  }
  function buildExtension(roamNames) {
    if (!runtime || catalog.tools.length === 0 || roamNames.has(FIND_TOOL_NAME)) return null;
    const durable = runtime.durable;
    const names = /* @__PURE__ */ new Set([FIND_TOOL_NAME]);
    const tools = [{
      name: FIND_TOOL_NAME,
      label: "Find extension tools",
      description: FIND_TOOL_DESCRIPTION,
      parameters: FIND_TOOL_PARAMETERS,
      executionMode: "parallel",
      replay: "safe",
      execute: (args, context) => runFind(args, context)
    }];
    for (const entry of catalog.tools) {
      if (roamNames.has(entry.chatName) || names.has(entry.chatName)) continue;
      names.add(entry.chatName);
      tools.push({
        name: entry.chatName,
        label: `${entry.extensionName}: ${entry.name}`,
        description: truncateText(`[${entry.extensionName}] ${entry.description || entry.name}`, MAX_CHAT_DESCRIPTION_CHARS),
        parameters: entry.parameters,
        deferred: true,
        executionMode: entry.readOnly ? "parallel" : "sequential",
        replay: entry.readOnly ? "safe" : "unsafe",
        outputLimits: { maxBytes: 24e4, maxLines: 6e4 },
        execute: (args, context) => runTool(entry.chatName, args, context)
      });
    }
    return {
      names,
      extension: durable.defineExtension({
        name: CHAT_EXTENSION_NAME,
        tools,
        sections: [durable.section(CHAT_SECTION_KEY, renderSection)],
        hooks: [durable.hook(durable.ToolTask, { beforeTool })]
      })
    };
  }
  function installInto(registry) {
    if (!attached || !runtime) return;
    try {
      const roam = registry.snapshot()?.extension?.(ROAM_EXTENSION_NAME);
      if (!roam) return;
      const roamNames = new Set((roam.tools ?? []).map((tool) => tool?.name).filter(Boolean));
      const key = `${instanceId}\0${catalog.signature}\0${[...roamNames].sort().join(",")}`;
      if (state.installed.get(registry) !== key) {
        const built = buildExtension(roamNames);
        if (!built) {
          registry.uninstall({ name: CHAT_EXTENSION_NAME });
          state.installed.delete(registry);
          installedNames = /* @__PURE__ */ new Set();
        } else {
          registry.install(built.extension);
          state.installed.set(registry, key);
          installedNames = built.names;
        }
      }
      if (state.patches?.conversation && state.installed.has(registry)) {
        setStatus({ phase: "attached", detail: "" });
      }
    } catch (error) {
      fail("installing into the chat registry failed", error);
    }
  }
  function adoptRegistry(registry) {
    state.registries.delete(registry);
    state.registries.add(registry);
    while (state.registries.size > MAX_TRACKED_REGISTRIES) {
      state.registries.delete(state.registries.values().next().value);
    }
    installInto(registry);
  }
  async function augmentConfig(conversation, config, context) {
    if (!isPlainObject2(config) || !Array.isArray(config.tools)) return config;
    const roamNames = config.tools.map((tool) => tool?.name).filter((name) => typeof name === "string");
    if (!ROAM_CHAT_MARKER_TOOLS.some((name) => roamNames.includes(name))) return config;
    stats.turns += 1;
    const conv = conversationState(conversation.id);
    conv.access = deriveChatAccess(roamNames);
    conv.offered = /* @__PURE__ */ new Set();
    await refresh();
    if (!attached) return config;
    if (!conv.probed) {
      conv.probed = true;
      try {
        await conversation.agent(context);
        await Promise.resolve();
      } catch (error) {
        warnOnce("probing the conversation failed", error);
      }
      if (!attached) return config;
    }
    const taken = new Set(roamNames);
    const allowed = catalog.tools.filter((tool) => installedNames.has(tool.chatName) && !taken.has(tool.chatName) && (tool.readOnly || conv.access !== "read"));
    if (allowed.length === 0 || !installedNames.has(FIND_TOOL_NAME)) {
      conv.offered = /* @__PURE__ */ new Set();
      return config;
    }
    const offeredNames = allowed.map((tool) => tool.chatName);
    conv.offered = new Set(offeredNames);
    const next = {
      ...config,
      tools: [...config.tools, { name: FIND_TOOL_NAME }, ...offeredNames.map((name) => ({ name }))]
    };
    if (config.modelTools === void 0) {
      const loaded = [...conv.loaded].filter((name) => conv.offered.has(name));
      if (loaded.length > 0) next.modelTools = { add: loaded.map((name) => ({ name })) };
    }
    return next;
  }
  async function verifyTurn(conversation, context) {
    if (!attached || state.status.verified === true) return;
    try {
      const agent = await conversation.agent(context);
      if (!attached) return;
      const names = (agent?.tools ?? []).map((tool) => tool?.name);
      setStatus({ verified: names.includes(FIND_TOOL_NAME) });
    } catch {
    }
  }
  async function preload(conversation, input, context, originalConfigure) {
    if (!isAutoLoadEnabled() || input?.type !== "input" || catalog.tools.length === 0) return;
    const conv = peekConversation(conversation.id);
    if (!conv?.access) return;
    const offered = conv.offered instanceof Set ? conv.offered : /* @__PURE__ */ new Set();
    if (offered.size === 0) return;
    let text = extractText(input.content);
    const blockRun = BLOCK_RUN_UID_RE.exec(text);
    if (blockRun) text = String(readBlockText2(blockRun[1]) ?? "");
    if (!text.trim()) return;
    const picks = suggestTools(catalog, text, { access: conv.access, exclude: [...conv.loaded], max: MAX_PRELOAD }).map((tool) => tool.chatName).filter((name) => offered.has(name) && installedNames.has(name));
    if (picks.length === 0) return;
    rememberLoaded(conv, picks);
    const activeLoaded = [...conv.loaded].filter((name) => {
      if (!offered.has(name) || !installedNames.has(name)) return false;
      const entry = catalog.byName.get(name);
      return Boolean(entry && (entry.readOnly || conv.access !== "read"));
    });
    if (activeLoaded.length === 0) return;
    await originalConfigure.call(
      conversation,
      { modelTools: { add: activeLoaded.map((name) => ({ name })) } },
      context
    );
    stats.preloads += 1;
  }
  const impl = {
    onRuntime,
    onRegistry: adoptRegistry,
    async configure(conversation, config, context, original) {
      let next = config;
      try {
        next = await augmentConfig(conversation, config, context);
      } catch (error) {
        warnOnce("preparing a turn failed", error);
        next = config;
      }
      if (next === config) return original.call(conversation, config, context);
      let result;
      try {
        result = await original.call(conversation, next, context);
      } catch (error) {
        const conv = peekConversation(conversation.id);
        if (conv) conv.offered = /* @__PURE__ */ new Set();
        warnOnce("Roam rejected the extended tool list", error);
        return original.call(conversation, config, context);
      }
      void verifyTurn(conversation, context);
      return result;
    },
    async submit(conversation, input, context, original, originalConfigure) {
      try {
        await preload(conversation, input, context, originalConfigure);
      } catch (error) {
        warnOnce("loading tools ahead of a turn failed", error);
      }
      return original.call(conversation, input, context);
    }
  };
  function patchRegistryPrototype(proto) {
    const originalInstall = proto.install;
    const originalSnapshot = proto.snapshot;
    if (typeof originalInstall !== "function" || typeof originalSnapshot !== "function" || typeof proto.uninstall !== "function") {
      throw new Error("the chat registry no longer has install, snapshot and uninstall");
    }
    const install = function install2(extension) {
      const result = originalInstall.call(this, extension);
      try {
        if (extension?.name === ROAM_EXTENSION_NAME) state.impl?.onRegistry(this);
      } catch (error) {
        logger.warn?.(`${LOG_PREFIX} Chat bridge: registry install hook failed`, error);
      }
      return result;
    };
    const snapshot = function snapshot2() {
      const result = originalSnapshot.call(this);
      try {
        if (state.impl && !state.registries.has(this) && result?.extension?.(ROAM_EXTENSION_NAME)) {
          state.registries.add(this);
          const registry = this;
          queueMicrotask(() => state.impl?.onRegistry(registry));
        }
      } catch (error) {
        logger.warn?.(`${LOG_PREFIX} Chat bridge: registry snapshot hook failed`, error);
      }
      return result;
    };
    proto.install = install;
    proto.snapshot = snapshot;
    return { proto, originalInstall, originalSnapshot, install, snapshot };
  }
  function patchConversationPrototype(proto) {
    const originalConfigure = proto.configure;
    const originalSubmit = proto.submit;
    if (typeof originalConfigure !== "function" || typeof originalSubmit !== "function" || typeof proto.agent !== "function") {
      throw new Error("a chat conversation no longer has configure, submit and agent");
    }
    const configure = function configure2(config, context) {
      const active = state.impl;
      if (!active) return originalConfigure.call(this, config, context);
      return active.configure(this, config, context, originalConfigure);
    };
    const submit = function submit2(input, context) {
      const active = state.impl;
      if (!active) return originalSubmit.call(this, input, context);
      return active.submit(this, input, context, originalSubmit, originalConfigure);
    };
    proto.configure = configure;
    proto.submit = submit;
    return { proto, originalConfigure, originalSubmit, configure, submit };
  }
  async function discoverConversationPrototype(piRuntime) {
    const durable = piRuntime.durable;
    const context = durable.BACKGROUND_CONTEXT;
    let harness;
    try {
      harness = await durable.Harness.open(
        new durable.MemoryStorage(),
        { models: piRuntime.createModels(), registry: durable.createRegistry(), settings: {} },
        context
      );
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
      return Object.getPrototypeOf(conversation);
    } finally {
      if (harness && typeof harness.close === "function") {
        try {
          await harness.close(context);
        } catch {
        }
      }
    }
  }
  async function onRuntime(piRuntime) {
    if (!attached) return;
    const problem = checkRuntimeShape(piRuntime);
    if (problem) {
      fail(`Roam's chat runtime changed: ${problem}`);
      return;
    }
    runtime = piRuntime;
    try {
      if (!state.patches) state.patches = { registry: null, conversation: null };
      if (!state.patches.registry) {
        state.patches.registry = patchRegistryPrototype(Object.getPrototypeOf(piRuntime.durable.createRegistry()));
      }
      await refresh({ force: true });
      if (!attached) return;
      if (!state.patches.conversation) {
        setStatus({ phase: "starting", detail: "" });
        const proto = await withTimeout(
          discoverConversationPrototype(piRuntime),
          DISCOVERY_TIMEOUT_MS,
          "Finding the chat conversation type"
        );
        if (!attached) return;
        if (!state.patches.conversation) state.patches.conversation = patchConversationPrototype(proto);
      }
      for (const registry of state.registries) installInto(registry);
      if (attached && state.status.phase !== "attached" && state.status.phase !== "failed") {
        setStatus({ phase: "ready", detail: "" });
      }
    } catch (error) {
      if (!attached) return;
      fail(`Roam's chat runtime changed: ${errorMessage(error)}`, error);
    }
  }
  function installRuntimeTrap() {
    if (state.trap) return true;
    const existing = Object.getOwnPropertyDescriptor(windowRef, RUNTIME_GLOBAL);
    if (existing && !existing.configurable) return false;
    let held;
    const trap = {
      get() {
        return held;
      },
      set(value) {
        held = value;
        state.trap = null;
        Object.defineProperty(windowRef, RUNTIME_GLOBAL, {
          configurable: true,
          enumerable: true,
          writable: true,
          value
        });
        if (value) void state.impl?.onRuntime(value);
      }
    };
    Object.defineProperty(windowRef, RUNTIME_GLOBAL, {
      configurable: true,
      enumerable: true,
      get: trap.get,
      set: trap.set
    });
    state.trap = trap;
    return true;
  }
  function removeRuntimeTrap() {
    const trap = state.trap;
    if (!trap) return;
    const existing = Object.getOwnPropertyDescriptor(windowRef, RUNTIME_GLOBAL);
    if (existing?.set === trap.set) delete windowRef[RUNTIME_GLOBAL];
    state.trap = null;
  }
  function restorePatches() {
    const patches = state.patches;
    if (!patches) return;
    let clean = true;
    const registry = patches.registry;
    if (registry) {
      if (registry.proto.install === registry.install && registry.proto.snapshot === registry.snapshot) {
        registry.proto.install = registry.originalInstall;
        registry.proto.snapshot = registry.originalSnapshot;
        patches.registry = null;
      } else {
        clean = false;
      }
    }
    const conversation = patches.conversation;
    if (conversation) {
      if (conversation.proto.configure === conversation.configure && conversation.proto.submit === conversation.submit) {
        conversation.proto.configure = conversation.originalConfigure;
        conversation.proto.submit = conversation.originalSubmit;
        patches.conversation = null;
      } else {
        clean = false;
      }
    }
    if (clean) state.patches = null;
  }
  return {
    attach() {
      if (attached) return;
      if (!hasWindow) {
        fail("there is no browser window to attach to");
        return;
      }
      attached = true;
      state.impl = impl;
      const existing = windowRef[RUNTIME_GLOBAL];
      if (existing) {
        setStatus({ phase: "starting", detail: "", verified: false });
        void onRuntime(existing);
      } else if (installRuntimeTrap()) {
        setStatus({ phase: "waiting", detail: "", verified: false });
      } else {
        fail("Roam's chat runtime cannot be observed in this window");
      }
    },
    detach() {
      if (!attached) return;
      attached = false;
      if (state.impl === impl) state.impl = null;
      for (const registry of state.registries) {
        try {
          registry.uninstall({ name: CHAT_EXTENSION_NAME });
        } catch {
        }
        state.installed.delete(registry);
      }
      installedNames = /* @__PURE__ */ new Set();
      removeRuntimeTrap();
      restorePatches();
      runtime = null;
      setStatus({ phase: "off", detail: "", verified: false });
    },
    /** Re-read extensions and settings and update the chat. */
    refresh: (options) => attached ? refresh({ force: true, ...options }) : Promise.resolve(),
    status: () => state.status,
    get attached() {
      return attached;
    }
  };
}

// src/chat-confirm.js
var MAX_ARGS_CHARS = 2e3;
function formatArgs(args) {
  let text;
  try {
    text = JSON.stringify(args ?? {}, null, 2);
  } catch {
    text = String(args);
  }
  if (typeof text !== "string") text = String(text);
  if (text.length <= MAX_ARGS_CHARS) return text;
  return `${text.slice(0, MAX_ARGS_CHARS)}
... (cut)`;
}
function createChatConfirm({ documentRef = globalThis.document } = {}) {
  const queue = [];
  let current = null;
  let disposed = false;
  let counter = 0;
  function element(tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== void 0) node.textContent = text;
    return node;
  }
  function settle(entry, decision) {
    if (entry.done) return;
    entry.done = true;
    entry.signal?.removeEventListener?.("abort", entry.onAbort);
    try {
      entry.backdrop?.remove();
    } catch {
    }
    if (current === entry) current = null;
    entry.resolve(decision);
  }
  function finish(entry, decision) {
    settle(entry, decision);
    showNext();
  }
  function show(entry) {
    current = entry;
    const { request } = entry;
    const extensionName = String(request.extensionName || "An extension");
    const toolName = String(request.toolName || "a tool");
    const titleId = `rth-confirm-title-${counter += 1}`;
    const backdrop = element("div", "rth-confirm-backdrop");
    const dialog = element("div", "bp3-dialog rth-confirm");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);
    const header = element("div", "bp3-dialog-header");
    const heading = element("h4", "bp3-heading", "Allow this change?");
    heading.id = titleId;
    header.append(heading);
    const body = element("div", "bp3-dialog-body");
    body.append(element("p", "", `${extensionName} wants to run ${toolName}.`));
    if (request.description) body.append(element("p", "", String(request.description)));
    body.append(element("pre", "", formatArgs(request.args)));
    const footer = element("div", "bp3-dialog-footer");
    const actions = element("div", "bp3-dialog-footer-actions");
    const buttons = [["Deny", "bp3-button", "deny"]];
    if (request.allowChat !== false) {
      buttons.push([`Allow ${extensionName} in this chat`, "bp3-button", "chat"]);
    }
    buttons.push(["Allow once", "bp3-button bp3-intent-primary", "once"]);
    for (const [label, className, decision] of buttons) {
      const button = element("button", className, label);
      button.setAttribute("type", "button");
      button.addEventListener("click", () => finish(entry, decision));
      actions.append(button);
    }
    footer.append(actions);
    dialog.append(header, body, footer);
    backdrop.append(dialog);
    entry.backdrop = backdrop;
    (documentRef.body ?? documentRef.documentElement).append(backdrop);
  }
  function showNext() {
    if (current || disposed) return;
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry.done) continue;
      if (entry.signal?.aborted) {
        settle(entry, "deny");
        continue;
      }
      try {
        show(entry);
      } catch {
        settle(entry, "deny");
        continue;
      }
      return;
    }
  }
  return {
    confirm(request = {}) {
      if (disposed || !documentRef?.createElement || request.signal?.aborted) {
        return Promise.resolve("deny");
      }
      return new Promise((resolve) => {
        const entry = { request, signal: request.signal, resolve, done: false, backdrop: null, onAbort: null };
        entry.onAbort = () => finish(entry, "deny");
        entry.signal?.addEventListener?.("abort", entry.onAbort, { once: true });
        queue.push(entry);
        showNext();
      });
    },
    dispose() {
      disposed = true;
      const pending = [...current ? [current] : [], ...queue.splice(0)];
      for (const entry of pending) {
        entry.done = true;
        entry.signal?.removeEventListener?.("abort", entry.onAbort);
        try {
          entry.backdrop?.remove();
        } catch {
        }
        entry.resolve("deny");
      }
      current = null;
    }
  };
}

// src/guidelines-index.js
var GUIDELINES_HEADING = "**Tool Hub** (Local MCP call_extension_tool only — in built-in Cmd-J chat, ignore this section and use normal Roam blocks/tables directly)";
var PAGE_PULL_PATTERN = "[:block/uid :node/title {:block/children [:block/uid :block/string :block/order {:block/children [:block/uid :block/string :block/order]}]}]";
var BLOCK_PULL_PATTERN = "[:block/uid :block/string {:block/page [:node/title :block/uid]} {:block/children [:block/uid :block/string :block/order]}]";
function sortByOrder(children) {
  if (!Array.isArray(children)) return [];
  return [...children].sort((a, b) => (a?.[":block/order"] ?? 0) - (b?.[":block/order"] ?? 0));
}
function defaultRoamApiGetter() {
  if (typeof globalThis.window !== "undefined" && globalThis.window.roamAlphaAPI) {
    return globalThis.window.roamAlphaAPI;
  }
  return globalThis.roamAlphaAPI || null;
}
function generateUid(roamAlphaAPI) {
  if (typeof roamAlphaAPI?.util?.generateUID === "function") {
    return roamAlphaAPI.util.generateUID();
  }
  return `rth${Math.random().toString(36).slice(2, 10)}`;
}
function sanitizeRoamMarkup(text) {
  let out = String(text ?? "").replace(/\s+/g, " ").replace(/`/g, "'").trim();
  if (!out) return "";
  for (let pass = 0; pass < 8; pass += 1) {
    const next = out.replace(/\{\{/g, "{ {").replace(/\}\}/g, "} }").replace(/\[\[/g, "[ [").replace(/\]\]/g, "] ]").replace(/\(\(/g, "( (").replace(/\)\)/g, ") )").replace(/::/g, ":");
    if (next === out) break;
    out = next;
  }
  return out.replace(/(^|[\s(])#([A-Za-z0-9_/-]+)/g, "$1`#$2`");
}
function pullWithReceiver(roamAlphaAPI, pattern, entity) {
  const pull = roamAlphaAPI?.data?.pull || roamAlphaAPI?.pull;
  if (typeof pull !== "function") return null;
  try {
    return pull.call(roamAlphaAPI.data || roamAlphaAPI, pattern, entity);
  } catch {
    return null;
  }
}
function pullGuidelinesPage(roamAlphaAPI) {
  return pullWithReceiver(roamAlphaAPI, PAGE_PULL_PATTERN, [
    ":node/title",
    GUIDELINES_PAGE_TITLE
  ]);
}
function findOwnedBlockOnGuidelinesPage(roamAlphaAPI, page, storedUid) {
  if (!storedUid) return null;
  const direct = pullWithReceiver(roamAlphaAPI, BLOCK_PULL_PATTERN, [":block/uid", storedUid]);
  if (direct?.[":block/uid"] === storedUid) {
    const pageRef = Array.isArray(direct[":block/page"]) ? direct[":block/page"][0] : direct[":block/page"];
    const pageTitle = pageRef?.[":node/title"];
    const pageUid = pageRef?.[":block/uid"];
    if (pageTitle === GUIDELINES_PAGE_TITLE || page?.[":block/uid"] && pageUid === page[":block/uid"]) {
      return direct;
    }
  }
  const topLevel = sortByOrder(page?.[":block/children"]);
  return topLevel.find((child) => child?.[":block/uid"] === storedUid) || null;
}
async function withGuidelinesLock(roamAlphaAPI, fn) {
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request !== "function") {
    return await fn();
  }
  const graphName = roamAlphaAPI?.graph?.name || "default";
  const lockName = `roam-tool-hub:guidelines:${graphName}`;
  return await locks.request(lockName, async () => await fn());
}
function buildGuidelinesIndexModel({
  extensions = [],
  isWriteEnabled = () => false
} = {}) {
  if (extensions.length === 0) {
    return {
      heading: GUIDELINES_HEADING,
      children: [
        "No extensions currently enabled in Tool Hub. Call list_extensions to check live tools."
      ]
    };
  }
  if (extensions.length <= GUIDELINES_SUMMARY_THRESHOLD) {
    const children2 = extensions.map((ext) => {
      const plural = ext.toolCount === 1 ? "tool" : "tools";
      const writeState = isWriteEnabled(ext.key) ? "writes on" : "writes off";
      const safeName = sanitizeRoamMarkup(ext.name);
      const safeKey = sanitizeRoamMarkup(ext.key);
      const safeSummary = sanitizeRoamMarkup(ext.summary);
      return `**${safeName}** (\`${safeKey}\`) — ${ext.toolCount} ${plural} (${ext.readCount} read, ${ext.writeCount} write, ${writeState}): ${safeSummary}`;
    });
    return { heading: GUIDELINES_HEADING, children: children2 };
  }
  const groups = /* @__PURE__ */ new Map();
  let totalTools = 0;
  for (const ext of extensions) {
    const groupName = sanitizeRoamMarkup(ext.group || "Other") || "Other";
    if (!groups.has(groupName)) groups.set(groupName, { count: 0, tools: 0 });
    const bucket = groups.get(groupName);
    bucket.count += 1;
    bucket.tools += ext.toolCount;
    totalTools += ext.toolCount;
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
    if (a === "Other" && b !== "Other") return 1;
    if (b === "Other" && a !== "Other") return -1;
    return a.localeCompare(b, void 0, { sensitivity: "base" });
  });
  const children = sortedGroups.map(([groupName, stats]) => {
    const extWord = stats.count === 1 ? "extension" : "extensions";
    const toolWord = stats.tools === 1 ? "tool" : "tools";
    return `${groupName}: ${stats.count} ${extWord} (${stats.tools} ${toolWord})`;
  });
  children.push(
    `Total: ${extensions.length} enabled extensions (${totalTools} tools). Call list_extensions to browse them.`
  );
  return { heading: GUIDELINES_HEADING, children };
}
async function syncGuidelinesIndex({
  extensionAPI,
  roamAlphaAPI = defaultRoamApiGetter(),
  getRegistry = defaultRegistryGetter,
  forceEnabled,
  allowShrink = true
} = {}) {
  const enabled = forceEnabled !== void 0 ? Boolean(forceEnabled) : isGuidelinesIndexEnabled(extensionAPI);
  if (!enabled) {
    return { status: "disabled", writes: 0 };
  }
  if (extensionAPI?.settings?.canSet === false) {
    return { status: "read-only-settings", writes: 0 };
  }
  if (!roamAlphaAPI?.data?.block || !roamAlphaAPI?.data?.page) {
    return { status: "no-roam-api", writes: 0 };
  }
  return await withGuidelinesLock(roamAlphaAPI, async () => {
    if (forceEnabled === void 0 && !isGuidelinesIndexEnabled(extensionAPI)) {
      return { status: "disabled", writes: 0 };
    }
    const snapshot = readRegistrySnapshot(getRegistry);
    const enabledExts = snapshot.extensions.filter((ext) => isExtensionEnabled(extensionAPI, ext.key));
    const model = buildGuidelinesIndexModel({
      extensions: enabledExts,
      isWriteEnabled: (key) => isExtensionWriteEnabled(extensionAPI, key)
    });
    let page = pullGuidelinesPage(roamAlphaAPI);
    let pageUid = page?.[":block/uid"] || null;
    let writes = 0;
    if (!pageUid) {
      const candidateUid = generateUid(roamAlphaAPI);
      try {
        await roamAlphaAPI.data.page.create({
          page: { title: GUIDELINES_PAGE_TITLE, uid: candidateUid }
        });
        writes += 1;
      } catch {
      }
      page = pullGuidelinesPage(roamAlphaAPI);
      pageUid = page?.[":block/uid"] || null;
      if (!pageUid) {
        return { status: "page-create-failed", writes };
      }
    }
    const storedUid = getGuidelinesBlockUid(extensionAPI);
    const existingBlock = findOwnedBlockOnGuidelinesPage(roamAlphaAPI, page, storedUid);
    if (!existingBlock) {
      if (!allowShrink && enabledExts.length === 0) {
        return { status: "deferred-empty-boot", writes: 0 };
      }
      const parentUid = generateUid(roamAlphaAPI);
      await roamAlphaAPI.data.block.create({
        location: { "parent-uid": pageUid, order: "last" },
        block: { uid: parentUid, string: model.heading }
      });
      writes += 1;
      await setGuidelinesBlockUid(extensionAPI, parentUid);
      for (let i = 0; i < model.children.length; i += 1) {
        await roamAlphaAPI.data.block.create({
          location: { "parent-uid": parentUid, order: i },
          block: { uid: generateUid(roamAlphaAPI), string: model.children[i] }
        });
        writes += 1;
      }
      return { status: "created", uid: parentUid, writes };
    }
    const existingChildren = sortByOrder(existingBlock[":block/children"]);
    if (!allowShrink && (enabledExts.length === 0 || model.children.length < existingChildren.length)) {
      return { status: "preserved-on-boot", uid: storedUid, writes: 0 };
    }
    const headingMatches = existingBlock[":block/string"] === model.heading;
    const childrenMatch = existingChildren.length === model.children.length && existingChildren.every((child, index) => child?.[":block/string"] === model.children[index]);
    if (headingMatches && childrenMatch) {
      return { status: "unchanged", uid: storedUid, writes: 0 };
    }
    if (!headingMatches) {
      await roamAlphaAPI.data.block.update({
        block: { uid: storedUid, string: model.heading }
      });
      writes += 1;
    }
    const sharedCount = Math.min(existingChildren.length, model.children.length);
    for (let i = 0; i < sharedCount; i += 1) {
      if (existingChildren[i]?.[":block/string"] !== model.children[i]) {
        await roamAlphaAPI.data.block.update({
          block: { uid: existingChildren[i][":block/uid"], string: model.children[i] }
        });
        writes += 1;
      }
    }
    for (let i = existingChildren.length; i < model.children.length; i += 1) {
      await roamAlphaAPI.data.block.create({
        location: { "parent-uid": storedUid, order: i },
        block: { uid: generateUid(roamAlphaAPI), string: model.children[i] }
      });
      writes += 1;
    }
    for (let i = existingChildren.length - 1; i >= model.children.length; i -= 1) {
      await roamAlphaAPI.data.block.delete({
        block: { uid: existingChildren[i][":block/uid"] }
      });
      writes += 1;
    }
    return { status: "updated", uid: storedUid, writes };
  });
}
async function removeGuidelinesIndex({
  extensionAPI,
  roamAlphaAPI = defaultRoamApiGetter()
} = {}) {
  if (extensionAPI?.settings?.canSet === false) {
    return { status: "read-only-settings", deleted: false };
  }
  if (!roamAlphaAPI?.data?.block) {
    return { status: "no-roam-api", deleted: false };
  }
  return await withGuidelinesLock(roamAlphaAPI, async () => {
    const storedUid = getGuidelinesBlockUid(extensionAPI);
    if (!storedUid) {
      return { status: "not-found", deleted: false };
    }
    const page = pullGuidelinesPage(roamAlphaAPI);
    const ownedBlock = findOwnedBlockOnGuidelinesPage(roamAlphaAPI, page, storedUid);
    if (ownedBlock) {
      await roamAlphaAPI.data.block.delete({
        block: { uid: storedUid }
      });
    }
    await setGuidelinesBlockUid(extensionAPI, null);
    return {
      status: ownedBlock ? "removed" : "cleared-stale-uid",
      uid: storedUid,
      deleted: Boolean(ownedBlock)
    };
  });
}

// src/lifecycle.js
function isPromiseLike(value) {
  return value != null && typeof value.then === "function";
}
async function callSafely(disposer) {
  const result = disposer();
  if (isPromiseLike(result)) await result;
}
function createLifecycle() {
  let disposed = false;
  const disposers = [];
  const add = (disposer) => {
    if (typeof disposer !== "function") throw new TypeError("A disposer must be a function");
    if (disposed) {
      void callSafely(disposer).catch((error) => console.error("[roam-tool-hub] Late cleanup failed", error));
      return disposer;
    }
    disposers.push(disposer);
    return disposer;
  };
  return {
    get disposed() {
      return disposed;
    },
    add,
    async command(commandApi, config) {
      if (!commandApi?.addCommand || !commandApi?.removeCommand) {
        throw new TypeError("A command API with addCommand/removeCommand is required");
      }
      await commandApi.addCommand(config);
      add(() => commandApi.removeCommand({ label: config.label }));
    },
    event(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      add(() => target.removeEventListener(type, listener, options));
      return listener;
    },
    interval(callback, delay, ...args) {
      const id = globalThis.setInterval(callback, delay, ...args);
      add(() => globalThis.clearInterval(id));
      return id;
    },
    timeout(callback, delay, ...args) {
      const id = globalThis.setTimeout(callback, delay, ...args);
      add(() => globalThis.clearTimeout(id));
      return id;
    },
    observer(observer, target, options) {
      observer.observe(target, options);
      add(() => observer.disconnect());
      return observer;
    },
    node(node, parent = globalThis.document?.body) {
      if (!parent) throw new Error("A parent node is required outside the browser");
      parent.append(node);
      add(() => node.remove());
      return node;
    },
    pullWatch(dataApi, pattern, entity, callback) {
      if (!dataApi?.addPullWatch || !dataApi?.removePullWatch) {
        throw new TypeError("A Roam data API with addPullWatch/removePullWatch is required");
      }
      dataApi.addPullWatch(pattern, entity, callback);
      add(() => dataApi.removePullWatch(pattern, entity, callback));
      return callback;
    },
    async settingsPanel(extensionAPI, config) {
      await extensionAPI.settings.panel.create(config);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const errors = [];
      for (const disposer of disposers.splice(0).reverse()) {
        try {
          await callSafely(disposer);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "One or more extension cleanups failed");
    }
  };
}

// src/extension.js
var activeLifecycle = null;
function resolveVersion(extension) {
  const raw = typeof extension?.version === "string" ? extension.version.trim() : "";
  if (raw && raw.toUpperCase() !== "DEV") return raw;
  return HUB_VERSION;
}
function snapshotSignature(snapshot) {
  return snapshot.extensions.map((ext) => [
    ext.key,
    ext.name,
    ext.version || "",
    ext.group || "",
    ext.summary,
    ext.guide || "",
    ext.toolCount,
    ext.readCount,
    ext.writeCount,
    ext.tools.map((t) => `${t.name}:${t.readOnly ? "r" : "w"}`).join(",")
  ].join(":")).join("|");
}
function setRuntimeVersion(version, lifecycle) {
  if (typeof globalThis.window === "undefined") return;
  globalThis.window[RUNTIME_VERSION_KEY] = version;
  lifecycle.add(() => {
    if (globalThis.window?.[RUNTIME_VERSION_KEY] === version) {
      delete globalThis.window[RUNTIME_VERSION_KEY];
    }
  });
}
function roamAi() {
  return globalThis.window?.roamAlphaAPI?.data?.ai;
}
async function getNativeTools() {
  const guidelines = await roamAi()?.getGraphGuidelines?.();
  return Array.isArray(guidelines?.extensionTools) ? guidelines.extensionTools : [];
}
function readBlockText(uid) {
  try {
    const pull = globalThis.window?.roamAlphaAPI?.pull;
    if (typeof pull !== "function") return "";
    const block = pull("[:block/string {:block/children [:block/string]}]", [":block/uid", uid]);
    if (!block) return "";
    const lines = [block[":block/string"], ...(block[":block/children"] ?? []).map((child) => child?.[":block/string"])];
    return lines.filter((line) => typeof line === "string" && line).join("\n");
  } catch {
    return "";
  }
}
async function onload({ extensionAPI, extension } = {}) {
  if (!extensionAPI) throw new TypeError("Roam did not provide extensionAPI");
  if (activeLifecycle) await activeLifecycle.dispose();
  const lifecycle = createLifecycle();
  activeLifecycle = lifecycle;
  const version = resolveVersion(extension);
  try {
    let lastSignature = null;
    let panelRunning = false;
    let panelDirty = false;
    let guidelinesPromise = null;
    let guidelinesDirty = false;
    let guidelinesAllowShrink = false;
    const drainGuidelinesQueue = () => {
      if (lifecycle.disposed) return Promise.resolve();
      if (guidelinesPromise) return guidelinesPromise;
      guidelinesPromise = (async () => {
        try {
          while (guidelinesDirty && !lifecycle.disposed) {
            const allowShrink = guidelinesAllowShrink;
            guidelinesDirty = false;
            guidelinesAllowShrink = false;
            if (extensionAPI.settings?.canSet === false) continue;
            try {
              if (isGuidelinesIndexEnabled(extensionAPI)) {
                await syncGuidelinesIndex({
                  extensionAPI,
                  getRegistry: defaultRegistryGetter,
                  allowShrink
                });
              } else {
                await removeGuidelinesIndex({ extensionAPI });
              }
            } catch (error) {
              console.warn(`${LOG_PREFIX} Guidelines index reconciliation failed`, error);
            }
          }
        } finally {
          guidelinesPromise = null;
        }
      })();
      return guidelinesPromise;
    };
    const scheduleGuidelinesReconcile = ({ allowShrink = true } = {}) => {
      if (lifecycle.disposed || extensionAPI.settings?.canSet === false) return Promise.resolve();
      guidelinesDirty = true;
      if (allowShrink) guidelinesAllowShrink = true;
      return drainGuidelinesQueue();
    };
    const handleToggleGuidelines = async (checked) => {
      if (lifecycle.disposed || extensionAPI.settings?.canSet === false) return;
      await extensionAPI.settings.set(SETTING_IDS.guidelinesEnabled, checked);
      await scheduleGuidelinesReconcile({ allowShrink: true });
    };
    const handleToggleExtension = async (extKey, field, checked) => {
      if (lifecycle.disposed || extensionAPI.settings?.canSet === false) return;
      const settingId = field === "write" ? extensionWriteSettingId(extKey) : field === "chatAuto" ? extensionChatAutoSettingId(extKey) : extensionEnabledSettingId(extKey);
      await extensionAPI.settings.set(settingId, checked);
      if (field !== "chatAuto" && isGuidelinesIndexEnabled(extensionAPI)) {
        await scheduleGuidelinesReconcile({ allowShrink: true });
      }
      await bridge.refresh().catch((error) => {
        console.warn(`${LOG_PREFIX} Chat bridge refresh failed`, error);
      });
    };
    const handleToggleChatBridge = async (checked) => {
      if (lifecycle.disposed || extensionAPI.settings?.canSet === false) return;
      await extensionAPI.settings.set(SETTING_IDS.chatBridgeEnabled, checked);
      if (checked) bridge.attach();
      else bridge.detach();
      await refreshSettingsPanel();
    };
    const handleToggleChatAutoLoad = async (checked) => {
      if (lifecycle.disposed || extensionAPI.settings?.canSet === false) return;
      await extensionAPI.settings.set(SETTING_IDS.chatAutoLoad, checked);
    };
    const refreshSettingsPanel = async ({ syncGuidelines = false, allowShrink = true } = {}) => {
      if (lifecycle.disposed) return;
      if (panelRunning) {
        panelDirty = true;
        if (syncGuidelines) void scheduleGuidelinesReconcile({ allowShrink });
        return;
      }
      panelRunning = true;
      try {
        do {
          panelDirty = false;
          const snapshot = readRegistrySnapshot(defaultRegistryGetter);
          let nativeExtensions = [];
          try {
            nativeExtensions = readNativeExtensions(await getNativeTools());
          } catch {
            nativeExtensions = [];
          }
          await seedExtensionDefaults(extensionAPI, [...snapshot.extensions, ...nativeExtensions]);
          if (lifecycle.disposed) return;
          lastSignature = snapshotSignature(snapshot);
          await lifecycle.settingsPanel(
            extensionAPI,
            createSettingsPanel({
              extensions: snapshot.extensions,
              nativeExtensions,
              chatStatus: bridge.status(),
              onRefresh: () => refreshSettingsPanel({ syncGuidelines: true, allowShrink: true }),
              onToggleExtension: handleToggleExtension,
              onToggleGuidelines: handleToggleGuidelines,
              onToggleChatBridge: handleToggleChatBridge,
              onToggleChatAutoLoad: handleToggleChatAutoLoad
            })
          );
        } while (panelDirty && !lifecycle.disposed);
      } finally {
        panelRunning = false;
      }
      if (syncGuidelines && !lifecycle.disposed && isGuidelinesIndexEnabled(extensionAPI)) {
        await scheduleGuidelinesReconcile({ allowShrink });
      }
    };
    const onSnapshot = (snapshot) => {
      if (lifecycle.disposed) return;
      const nextSignature = snapshotSignature(snapshot);
      if (nextSignature !== lastSignature) {
        void refreshSettingsPanel({ syncGuidelines: false }).catch((error) => {
          console.warn(`${LOG_PREFIX} Settings panel refresh failed`, error);
        });
      }
    };
    const tools = createHubTools({
      extensionAPI,
      getRegistry: defaultRegistryGetter,
      onSnapshot
    });
    const runTool = tools.find((tool) => tool.name === "run_tool");
    const confirm = createChatConfirm();
    let lastStatusText = describeChatBridgeStatus({ phase: "off" });
    const bridge = createChatBridge({
      extensionAPI,
      getRegistrySnapshot: () => readRegistrySnapshot(defaultRegistryGetter),
      getNativeTools,
      callNativeTool: (id, args) => roamAi().callExtensionTool({ tool: id, args }),
      runRegistryTool: (id, args) => runTool.handler({ tool: id, args }, {}),
      confirmWrite: (request) => confirm.confirm(request),
      isAutoLoadEnabled: () => isChatAutoLoadEnabled(extensionAPI),
      isChatAutoApproved: (extKey) => isChatAutoApproved(extensionAPI, extKey),
      readBlockText,
      onStatus: (status) => {
        const text = describeChatBridgeStatus(status);
        if (text === lastStatusText || lifecycle.disposed) return;
        lastStatusText = text;
        void refreshSettingsPanel().catch((error) => {
          console.warn(`${LOG_PREFIX} Settings panel refresh failed`, error);
        });
      }
    });
    lifecycle.add(() => {
      bridge.detach();
      confirm.dispose();
    });
    await refreshSettingsPanel({ syncGuidelines: true, allowShrink: false });
    if (lifecycle.disposed) return async () => {
    };
    if (isChatBridgeEnabled(extensionAPI)) bridge.attach();
    const unregisterTools = registerHubTools(extensionAPI, tools);
    lifecycle.add(unregisterTools);
    if (extensionAPI.ui?.commandPalette) {
      await lifecycle.command(extensionAPI.ui.commandPalette, {
        label: "Tool Hub: Refresh registry & settings",
        callback: () => {
          void refreshSettingsPanel({ syncGuidelines: true, allowShrink: true });
          void bridge.refresh().catch((error) => {
            console.warn(`${LOG_PREFIX} Chat bridge refresh failed`, error);
          });
        }
      });
      if (lifecycle.disposed) return async () => {
      };
    }
    setRuntimeVersion(version, lifecycle);
    console.info(`${LOG_PREFIX} Loaded v${version}`);
  } catch (error) {
    if (activeLifecycle === lifecycle) activeLifecycle = null;
    await lifecycle.dispose().catch((cleanupError) => console.error(cleanupError));
    throw error;
  }
  return async () => {
    if (activeLifecycle === lifecycle) activeLifecycle = null;
    await lifecycle.dispose();
  };
}
async function onunload() {
  const lifecycle = activeLifecycle;
  activeLifecycle = null;
  if (lifecycle) await lifecycle.dispose();
  console.info(`${LOG_PREFIX} Unloaded`);
}
var extension_default = { onload, onunload };
export {
  extension_default as default,
  onload,
  onunload
};
