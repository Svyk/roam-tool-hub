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

function snapshotSignature(snapshot) {
  return snapshot.extensions
    .map((ext) => `${ext.key}:${ext.name}:${ext.toolCount}:${ext.readCount}:${ext.writeCount}`)
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
  const version = extension?.version || HUB_VERSION;

  try {
    let lastSignature = null;
    let refreshing = false;

    const syncGuidelinesIfEnabled = async (forceEnabled) => {
      if (lifecycle.disposed) return;
      try {
        await syncGuidelinesIndex({
          extensionAPI,
          getRegistry: defaultRegistryGetter,
          forceEnabled,
        });
      } catch (error) {
        console.warn(`${LOG_PREFIX} Guidelines index sync failed`, error);
      }
    };

    const handleToggleGuidelines = async (checked) => {
      if (lifecycle.disposed) return;
      if (extensionAPI.settings?.canSet !== false) {
        await extensionAPI.settings.set(SETTING_IDS.guidelinesEnabled, checked);
      }
      if (checked) {
        await syncGuidelinesIfEnabled(true);
      } else {
        try {
          await removeGuidelinesIndex({ extensionAPI });
        } catch (error) {
          console.warn(`${LOG_PREFIX} Guidelines index removal failed`, error);
        }
      }
    };

    const handleToggleExtension = async (extKey, field, checked) => {
      if (lifecycle.disposed) return;
      const settingId = field === "write"
        ? extensionWriteSettingId(extKey)
        : extensionEnabledSettingId(extKey);
      if (extensionAPI.settings?.canSet !== false) {
        await extensionAPI.settings.set(settingId, checked);
      }
      if (isGuidelinesIndexEnabled(extensionAPI)) {
        await syncGuidelinesIfEnabled(true);
      }
    };

    const refreshSettingsPanel = async (
      snapshot = readRegistrySnapshot(defaultRegistryGetter),
      { syncGuidelines = false } = {},
    ) => {
      if (lifecycle.disposed || refreshing) return;
      refreshing = true;
      try {
        await seedExtensionDefaults(extensionAPI, snapshot.extensions);
        if (lifecycle.disposed) return;
        lastSignature = snapshotSignature(snapshot);
        await lifecycle.settingsPanel(
          extensionAPI,
          createSettingsPanel({
            extensions: snapshot.extensions,
            onRefresh: () => refreshSettingsPanel(undefined, { syncGuidelines: true }),
            onToggleExtension: handleToggleExtension,
            onToggleGuidelines: handleToggleGuidelines,
          }),
        );
        if (syncGuidelines && isGuidelinesIndexEnabled(extensionAPI)) {
          await syncGuidelinesIfEnabled(true);
        }
      } finally {
        refreshing = false;
      }
    };

    const onSnapshot = (snapshot) => {
      const nextSignature = snapshotSignature(snapshot);
      if (nextSignature !== lastSignature) {
        void refreshSettingsPanel(snapshot, { syncGuidelines: true }).catch((error) => {
          console.warn(`${LOG_PREFIX} Settings panel refresh failed`, error);
        });
      }
    };

    await refreshSettingsPanel(undefined, { syncGuidelines: true });

    const tools = createHubTools({
      extensionAPI,
      getRegistry: defaultRegistryGetter,
      onSnapshot,
    });
    const unregisterTools = registerHubTools(extensionAPI, tools);
    lifecycle.add(unregisterTools);

    if (extensionAPI.ui?.commandPalette) {
      await lifecycle.command(extensionAPI.ui.commandPalette, {
        label: "Tool Hub: Refresh registry & settings",
        callback: () => {
          void refreshSettingsPanel(undefined, { syncGuidelines: true });
        },
      });
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
