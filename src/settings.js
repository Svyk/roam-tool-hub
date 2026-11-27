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

export function createSettingsPanel({
  extensions = [],
  onRefresh,
  onToggleExtension,
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
  }

  return {
    tabTitle: "Tool Hub",
    settings,
  };
}
