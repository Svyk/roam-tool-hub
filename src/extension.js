import { HUB_VERSION, LOG_PREFIX, RUNTIME_VERSION_KEY, SETTING_IDS } from "./constants.js";
import { removeGuidelinesIndex, syncGuidelinesIndex } from "./guidelines-index.js";
import { createHubTools, registerHubTools } from "./hub-tools.js";
import { createLifecycle } from "./lifecycle.js";
import { defaultRegistryGetter, readRegistrySnapshot } from "./registry.js";
import {
  createSettingsPanel,
  extensionEnabledSettingId,
  extensionWriteSettingId,
  isGuidelinesIndexEnabled,
  seedExtensionDefaults,
} from "./settings.js";

let activeLifecycle = null;

function resolveVersion(extension) {
  const raw = typeof extension?.version === "string" ? extension.version.trim() : "";
  if (raw && raw.toUpperCase() !== "DEV") return raw;
  return HUB_VERSION;
}

function snapshotSignature(snapshot) {
  return snapshot.extensions
    .map((ext) => [
      ext.key,
      ext.name,
      ext.version || "",
      ext.group || "",
      ext.summary,
      ext.toolCount,
      ext.readCount,
      ext.writeCount,
      ext.tools.map((t) => `${t.name}:${t.readOnly ? "r" : "w"}`).join(","),
    ].join(":"))
    .join("|");
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

export async function onload({ extensionAPI, extension } = {}) {
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
                  allowShrink,
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
      const settingId = field === "write"
        ? extensionWriteSettingId(extKey)
        : extensionEnabledSettingId(extKey);
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
              onToggleGuidelines: handleToggleGuidelines,
            }),
          );
        } while (panelDirty && !lifecycle.disposed);
      } finally {
        panelRunning = false;
      }
      if (syncGuidelines && !lifecycle.disposed && isGuidelinesIndexEnabled(extensionAPI)) {
        await scheduleGuidelinesReconcile({ allowShrink });
      }
    };

    // Read-only AI tool calls update the settings panel lazily without issuing graph writes.
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
      onSnapshot,
    });

    await refreshSettingsPanel({ syncGuidelines: true, allowShrink: false });
    if (lifecycle.disposed) return async () => {};

    const unregisterTools = registerHubTools(extensionAPI, tools);
    lifecycle.add(unregisterTools);

    if (extensionAPI.ui?.commandPalette) {
      await lifecycle.command(extensionAPI.ui.commandPalette, {
        label: "Tool Hub: Refresh registry & settings",
        callback: () => {
          void refreshSettingsPanel({ syncGuidelines: true, allowShrink: true });
        },
      });
      if (lifecycle.disposed) return async () => {};
    }

    setRuntimeVersion(version, lifecycle);
    console.info(`${LOG_PREFIX} Loaded v${version}`);
  } catch (error) {
    if (activeLifecycle === lifecycle) activeLifecycle = null;
    await lifecycle.dispose().catch((cleanupError) => console.error(cleanupError));
    throw error;
  }

  // Roam invokes this cleanup immediately before onunload.
  // Unload intentionally does NOT remove the guidelines index block because reload triggers onunload.
  return async () => {
    if (activeLifecycle === lifecycle) activeLifecycle = null;
    await lifecycle.dispose();
  };
}

export async function onunload() {
  const lifecycle = activeLifecycle;
  activeLifecycle = null;
  if (lifecycle) await lifecycle.dispose();
  console.info(`${LOG_PREFIX} Unloaded`);
}

export default { onload, onunload };
