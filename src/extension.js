import { HUB_VERSION, LOG_PREFIX, RUNTIME_VERSION_KEY, SETTING_IDS } from "./constants.js";
import { createChatBridge } from "./chat-bridge.js";
import { readNativeExtensions } from "./chat-catalog.js";
import { createChatConfirm } from "./chat-confirm.js";
import { removeGuidelinesIndex, syncGuidelinesIndex } from "./guidelines-index.js";
import { createHubTools, registerHubTools } from "./hub-tools.js";
import { createLifecycle } from "./lifecycle.js";
import { defaultRegistryGetter, readRegistrySnapshot } from "./registry.js";
import {
  createSettingsPanel,
  describeChatBridgeStatus,
  extensionChatAutoSettingId,
  extensionEnabledSettingId,
  extensionWriteSettingId,
  isChatAutoApproved,
  isChatAutoLoadEnabled,
  isChatBridgeEnabled,
  isGuidelinesIndexEnabled,
  seedExtensionDefaults,
  setChatAutoApproved,
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
      ext.guide || "",
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

function roamAi() {
  return globalThis.window?.roamAlphaAPI?.data?.ai;
}

async function getNativeTools() {
  try {
    const guidelines = await roamAi()?.getGraphGuidelines?.();
    return Array.isArray(guidelines?.extensionTools) ? guidelines.extensionTools : [];
  } catch {
    return [];
  }
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
        : field === "chatAuto"
          ? extensionChatAutoSettingId(extKey)
          : extensionEnabledSettingId(extKey);
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
              onToggleChatAutoLoad: handleToggleChatAutoLoad,
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
      setChatAutoApproved: (extKey, value) => setChatAutoApproved(extensionAPI, extKey, value),
      readBlockText,
      onStatus: (status) => {
        const text = describeChatBridgeStatus(status);
        if (text === lastStatusText || lifecycle.disposed) return;
        lastStatusText = text;
        void refreshSettingsPanel().catch((error) => {
          console.warn(`${LOG_PREFIX} Settings panel refresh failed`, error);
        });
      },
    });
    lifecycle.add(() => {
      bridge.detach();
      confirm.dispose();
    });

    await refreshSettingsPanel({ syncGuidelines: true, allowShrink: false });
    if (lifecycle.disposed) return async () => {};

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
