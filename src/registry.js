import { MAX_GUIDE_CHARS, MAX_SUMMARY_CHARS, MAX_TOOL_DESCRIPTION_CHARS } from "./constants.js";

function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function safeSlice(text, maxChars) {
  if (typeof text !== "string" || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

export function truncateText(text, maxChars) {
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

export function isToolReadOnly(rawTool) {
  return rawTool?.readOnly === true && rawTool?.isMutating !== true;
}

export function defaultRegistryGetter() {
  if (typeof globalThis.window !== "undefined" && globalThis.window.RoamExtensionTools) {
    return globalThis.window.RoamExtensionTools;
  }
  if (globalThis.RoamExtensionTools) {
    return globalThis.RoamExtensionTools;
  }
  return {};
}

export function readRegistrySnapshot(getRegistry = defaultRegistryGetter) {
  let rawRegistry;
  try {
    rawRegistry = typeof getRegistry === "function" ? getRegistry() : getRegistry;
  } catch {
    rawRegistry = null;
  }
  if (!rawRegistry || typeof rawRegistry !== "object") {
    return { extensions: [], byKey: new Map(), toolsById: new Map() };
  }

  const extensions = [];
  const byKey = new Map();
  const toolsById = new Map();

  for (const [extKey, ext] of Object.entries(rawRegistry)) {
    if (!extKey || extKey.includes("/") || !ext || typeof ext !== "object" || !Array.isArray(ext.tools)) continue;

    const name = collapseWhitespace(ext.name) || extKey;
    const version = collapseWhitespace(ext.version) || null;
    const group = collapseWhitespace(ext.group) || null;

    const seenNames = new Set();
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
      const parameters = rawTool.parameters && typeof rawTool.parameters === "object" && !Array.isArray(rawTool.parameters)
        ? rawTool.parameters
        : { type: "object", properties: {} };

      const normalizedTool = {
        id,
        extensionKey: extKey,
        extensionName: name,
        name: toolName,
        description,
        shortDescription: truncateText(description, MAX_TOOL_DESCRIPTION_CHARS),
        readOnly: isToolReadOnly(rawTool),
        parameters,
        execute: (args, context) => rawTool.execute(args, context),
      };
      tools.push(normalizedTool);
      toolsById.set(id, normalizedTool);
    }

    if (tools.length === 0) continue;

    const readCount = tools.filter((t) => t.readOnly).length;
    const writeCount = tools.length - readCount;
    const summary = deriveExtensionSummary(ext, tools);
    const guide = typeof ext.guide === "string" && ext.guide.trim()
      ? truncateText(ext.guide, MAX_GUIDE_CHARS)
      : "";

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
      writeCount,
    };
    extensions.push(record);
    byKey.set(extKey, record);
  }

  extensions.sort((a, b) => (
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    || a.key.localeCompare(b.key)
  ));

  return { extensions, byKey, toolsById };
}
