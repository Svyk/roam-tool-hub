import { SETTING_IDS } from "./constants.js";

/**
 * Encodes an extension key into a Roam-safe setting key segment.
 * Roam forbids ".", "#", "$", "[", "]" (and Firebase forbids "/" and control chars).
 */
export function encodeSettingKeySegment(raw) {
  return String(raw).replace(/[~.#$[\]/\x00-\x1f\x7f]/g, (ch) => (
    `~${ch.charCodeAt(0).toString(16).padStart(2, "0")}`
  ));
}

export function extensionEnabledSettingId(extKey) {
  return `ext:${encodeSettingKeySegment(extKey)}:enabled`;
}

export function extensionWriteSettingId(extKey) {
  return `ext:${encodeSettingKeySegment(extKey)}:write`;
}

export function extensionChatAutoSettingId(extKey) {
  return `ext:${encodeSettingKeySegment(extKey)}:chat-auto`;
}

export function isExtensionEnabled(extensionAPI, extKey) {
  const value = extensionAPI?.settings?.get?.(extensionEnabledSettingId(extKey));
  // Default for a newly seen extension: read tools on (enabled = true).
  return value === null || value === undefined ? true : Boolean(value);
}

export function isExtensionWriteEnabled(extensionAPI, extKey) {
  const value = extensionAPI?.settings?.get?.(extensionWriteSettingId(extKey));
  // Default for a newly seen extension: writing tools off (write = false).
  return value === null || value === undefined ? false : Boolean(value);
}

export function isGuidelinesIndexEnabled(extensionAPI) {
  const value = extensionAPI?.settings?.get?.(SETTING_IDS.guidelinesEnabled);
  return value === true;
}

export function isChatBridgeEnabled(extensionAPI) {
  return extensionAPI?.settings?.get?.(SETTING_IDS.chatBridgeEnabled) === true;
}

export function isChatAutoLoadEnabled(extensionAPI) {
  return extensionAPI?.settings?.get?.(SETTING_IDS.chatAutoLoad) !== false;
}

export function isChatAutoApproved(extensionAPI, extKey) {
  return extensionAPI?.settings?.get?.(extensionChatAutoSettingId(extKey)) === true;
}

export async function setChatAutoApproved(extensionAPI, extKey, value) {
  if (extensionAPI?.settings?.canSet === false) return;
  await extensionAPI?.settings?.set?.(extensionChatAutoSettingId(extKey), Boolean(value));
}

export function describeChatBridgeStatus(status) {
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

export function getGuidelinesBlockUid(extensionAPI) {
  const value = extensionAPI?.settings?.get?.(SETTING_IDS.guidelinesBlockUid);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function setGuidelinesBlockUid(extensionAPI, uid) {
  if (extensionAPI?.settings?.canSet === false) return;
  await extensionAPI?.settings?.set?.(SETTING_IDS.guidelinesBlockUid, uid || null);
}

export async function seedExtensionDefaults(extensionAPI, extensions) {
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

export function createSettingsPanel({
  extensions = [],
  nativeExtensions = [],
  chatStatus,
  onRefresh,
  onToggleExtension,
  onToggleGuidelines,
  onToggleChatBridge,
  onToggleChatAutoLoad,
} = {}) {
  const settings = [
    {
      id: SETTING_IDS.refreshButton,
      name: "Refresh discovered extensions",
      description: extensions.length
        ? `Currently seeing ${extensions.length} extension${extensions.length === 1 ? "" : "s"} in window.RoamExtensionTools.`
        : "No extensions found in window.RoamExtensionTools yet. Click Refresh after other extensions finish loading.",
      action: {
        type: "button",
        content: "Refresh",
        onClick: () => {
          void onRefresh?.();
        },
      },
    },
    {
      id: SETTING_IDS.guidelinesEnabled,
      name: "Publish index on roam/agent guidelines",
      description: "Maintain one generated Tool Hub summary block on [[roam/agent guidelines]] for Local MCP clients (scoped so built-in Cmd-J ignores it). Click Refresh to sync late-loading extensions. Turning this off removes that block.",
      action: {
        type: "switch",
        onChange: (event) => {
          void onToggleGuidelines?.(Boolean(event?.target?.checked));
        },
      },
    },
    {
      id: SETTING_IDS.chatBridgeEnabled,
      name: "Built-in chat bridge (experimental)",
      description: `Let Roam's own AI chat (Cmd-J, Ask AI) use these extensions' tools. Uses an undocumented part of Roam and turns itself off if Roam changes it. Status: ${describeChatBridgeStatus(chatStatus)}`,
      action: {
        type: "switch",
        onChange: (event) => {
          void onToggleChatBridge?.(Boolean(event?.target?.checked));
        },
      },
    },
    {
      id: SETTING_IDS.chatAutoLoad,
      name: "Chat: load matching tools automatically",
      description: "Before each chat turn, put the tools that match your message in front of the model so it does not have to look for them.",
      action: {
        type: "switch",
        onChange: (event) => {
          void onToggleChatAutoLoad?.(Boolean(event?.target?.checked));
        },
      },
    },
  ];

  const chatAutoRow = (ext, name, description) => ({
    id: extensionChatAutoSettingId(ext.key),
    name: `${name} — chat may change the graph without asking`,
    description,
    action: {
      type: "switch",
      onChange: (event) => {
        void onToggleExtension?.(ext.key, "chatAuto", Boolean(event?.target?.checked));
      },
    },
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
        },
      },
    });
    settings.push({
      id: extensionWriteSettingId(ext.key),
      name: `${ext.name} — allow writing tools`,
      description: ext.writeCount > 0
        ? `Allow run_tool to invoke ${ext.writeCount} non-read-only tool${ext.writeCount === 1 ? "" : "s"} from ${ext.key}. Default off.`
        : `Allow run_tool to invoke non-read-only tools from ${ext.key} if any are added later. Default off.`,
      action: {
        type: "switch",
        onChange: (event) => {
          void onToggleExtension?.(ext.key, "write", Boolean(event?.target?.checked));
        },
      },
    });
    if (ext.writeCount > 0) {
      settings.push(chatAutoRow(
        ext,
        ext.name,
        `Skip the confirm dialog when the built-in chat runs a writing tool from ${ext.key}. Tools that delete, or change things in bulk, still ask. Default off.`,
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
        },
      },
    });
    settings.push({
      id: extensionWriteSettingId(ext.key),
      name: `${label} — allow writing tools`,
      description: `Allow the built-in chat bridge to offer ${ext.writeCount} non-read-only tool${ext.writeCount === 1 ? "" : "s"} from ${ext.key}. The switch applies to the built-in chat bridge only, since MCP clients already see native tools directly. Default off.`,
      action: {
        type: "switch",
        onChange: (event) => {
          void onToggleExtension?.(ext.key, "write", Boolean(event?.target?.checked));
        },
      },
    });
    if (ext.writeCount > 0) {
      settings.push(chatAutoRow(
        ext,
        label,
        `Skip the confirm dialog when the built-in chat runs a writing tool from ${ext.key}. Tools that delete, or change things in bulk, still ask. The switch applies to the built-in chat bridge only, since MCP clients already see native tools directly. Default off.`,
      ));
    }
  }

  return {
    tabTitle: "Tool Hub",
    settings,
  };
}
