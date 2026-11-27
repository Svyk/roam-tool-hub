import { MAX_SUMMARY_CHARS, MAX_TOOL_DESCRIPTION_CHARS } from "./constants.js";

function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function truncateText(text, maxChars) {
  const clean = collapseWhitespace(text);
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 1) return clean.slice(0, maxChars);
  return `${clean.slice(0, maxChars - 1)}…`;
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
  const joined = snippets.join(" ");
  return truncateText(joined, MAX_SUMMARY_CHARS);
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
    if (!extKey || !ext || typeof ext !== "object" || !Array.isArray(ext.tools)) continue;

    const name = typeof ext.name === "string" && ext.name.trim() ? ext.name.trim() : extKey;
    const version = typeof ext.version === "string" && ext.version.trim() ? ext.version.trim() : null;
    const group = typeof ext.group === "string" && ext.group.trim() ? ext.group.trim() : null;

    const seenNames = new Set();
    const tools = [];
    for (const rawTool of ext.tools) {
      if (!rawTool || typeof rawTool !== "object") continue;
      if (typeof rawTool.name !== "string" || !rawTool.name.trim()) continue;
      if (typeof rawTool.execute !== "function") continue;

      const toolName = rawTool.name.trim();
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
        execute: rawTool.execute,
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
