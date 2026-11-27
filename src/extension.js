import { HUB_VERSION, LOG_PREFIX, RUNTIME_VERSION_KEY } from "./constants.js";
import { createHubTools, registerHubTools } from "./hub-tools.js";
import { createLifecycle } from "./lifecycle.js";
import { defaultRegistryGetter, readRegistrySnapshot } from "./registry.js";
import { createSettingsPanel, seedExtensionDefaults } from "./settings.js";

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

    const refreshSettingsPanel = async (snapshot = readRegistrySnapshot(defaultRegistryGetter)) => {
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
            onRefresh: () => refreshSettingsPanel(),
          }),
        );
      } finally {
        refreshing = false;
      }
    };

    const onSnapshot = (snapshot) => {
      const nextSignature = snapshotSignature(snapshot);
      if (nextSignature !== lastSignature) {
        void refreshSettingsPanel(snapshot).catch((error) => {
          console.warn(`${LOG_PREFIX} Settings panel refresh failed`, error);
        });
      }
    };

    await refreshSettingsPanel();

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
          void refreshSettingsPanel();
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
