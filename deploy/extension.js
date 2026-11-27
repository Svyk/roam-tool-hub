/* Tool Hub v0.3.0 | MIT | generated; edit src/ */

// src/constants.js
var HUB_VERSION = "0.3.0";
var LOG_PREFIX = "[roam-tool-hub]";
var RUNTIME_VERSION_KEY = "__ROAM_TOOL_HUB_VERSION";
var MAX_TOOL_DESCRIPTION_CHARS = 300;
var MAX_SUMMARY_CHARS = 140;
var MAX_DESCRIBE_TOOLS = 5;
var DEFAULT_FIND_LIMIT = 25;
var MAX_FIND_LIMIT = 100;
var MAX_RESULT_CHARS = 4e4;
var GUIDELINES_PAGE_TITLE = "roam/agent guidelines";
var GUIDELINES_SUMMARY_THRESHOLD = 20;
var SETTING_IDS = Object.freeze({
  refreshButton: "refresh-extensions",
  guidelinesEnabled: "guidelines-index-enabled",
  guidelinesBlockUid: "guidelines-block-uid"
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
    const record = {
      key: extKey,
      name,
      version,
      group,
      summary,
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
  for (const ext of extensions) {
    const enabledId = extensionEnabledSettingId(ext.key);
    if (extensionAPI.settings.get(enabledId) == null) {
      await extensionAPI.settings.set(enabledId, true);
    }
    const writeId = extensionWriteSettingId(ext.key);
    if (extensionAPI.settings.get(writeId) == null) {
      await extensionAPI.settings.set(writeId, false);
    }
  }
}
function createSettingsPanel({
  extensions = [],
  onRefresh,
  onToggleExtension,
  onToggleGuidelines
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
    }
  ];
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
  }
  return {
    tabTitle: "Tool Hub",
    settings
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
      return {
        tools: slice,
        totalMatched: matched.length,
        truncated: matched.length > slice.length
      };
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
      const settingId = field === "write" ? extensionWriteSettingId(extKey) : extensionEnabledSettingId(extKey);
      await extensionAPI.settings.set(settingId, checked);
      if (isGuidelinesIndexEnabled(extensionAPI)) {
        await scheduleGuidelinesReconcile({ allowShrink: true });
      }
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
          await seedExtensionDefaults(extensionAPI, snapshot.extensions);
          if (lifecycle.disposed) return;
          lastSignature = snapshotSignature(snapshot);
          await lifecycle.settingsPanel(
            extensionAPI,
            createSettingsPanel({
              extensions: snapshot.extensions,
              onRefresh: () => refreshSettingsPanel({ syncGuidelines: true, allowShrink: true }),
              onToggleExtension: handleToggleExtension,
              onToggleGuidelines: handleToggleGuidelines
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
    await refreshSettingsPanel({ syncGuidelines: true, allowShrink: false });
    if (lifecycle.disposed) return async () => {
    };
    const unregisterTools = registerHubTools(extensionAPI, tools);
    lifecycle.add(unregisterTools);
    if (extensionAPI.ui?.commandPalette) {
      await lifecycle.command(extensionAPI.ui.commandPalette, {
        label: "Tool Hub: Refresh registry & settings",
        callback: () => {
          void refreshSettingsPanel({ syncGuidelines: true, allowShrink: true });
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
