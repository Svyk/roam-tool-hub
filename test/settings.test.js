import assert from "node:assert/strict";
import test from "node:test";

import {
  createSettingsPanel,
  describeChatBridgeStatus,
  encodeSettingKeySegment,
  extensionChatAutoSettingId,
  extensionEnabledSettingId,
  extensionWriteSettingId,
  isChatAutoApproved,
  isChatAutoLoadEnabled,
  isChatBridgeEnabled,
  isExtensionEnabled,
  isExtensionWriteEnabled,
  seedExtensionDefaults,
  setChatAutoApproved,
} from "../src/settings.js";

function makeFakeSettingsApi({ canSet = true } = {}) {
  const store = new Map();
  return {
    store,
    settings: {
      canSet,
      get: (key) => (store.has(key) ? store.get(key) : null),
      set: async (key, value) => {
        store.set(key, value);
        return null;
      },
    },
  };
}

test("encodeSettingKeySegment strips Roam-forbidden characters losslessly", () => {
  assert.equal(encodeSettingKeySegment("roam-grid"), "roam-grid");
  const weird = encodeSettingKeySegment("org.ext#1$a[0]/v~1");
  assert.doesNotMatch(weird, /[.#$[\]/]/);
  assert.notEqual(encodeSettingKeySegment("a.b"), encodeSettingKeySegment("a~2eb"));
});

test("defaults are read tools on and writing tools off for newly seen extensions", async () => {
  const api = makeFakeSettingsApi();
  assert.equal(isExtensionEnabled(api, "roam-grid"), true);
  assert.equal(isExtensionWriteEnabled(api, "roam-grid"), false);

  await seedExtensionDefaults(api, [{ key: "roam-grid" }]);
  assert.equal(api.store.get(extensionEnabledSettingId("roam-grid")), true);
  assert.equal(api.store.get(extensionWriteSettingId("roam-grid")), false);
  assert.equal(api.store.get(extensionChatAutoSettingId("roam-grid")), false);
  assert.equal(api.store.get("chat-bridge-enabled"), false);
  assert.equal(api.store.get("chat-auto-load"), true);

  await api.settings.set(extensionEnabledSettingId("roam-grid"), false);
  await api.settings.set(extensionWriteSettingId("roam-grid"), true);
  assert.equal(isExtensionEnabled(api, "roam-grid"), false);
  assert.equal(isExtensionWriteEnabled(api, "roam-grid"), true);
});

test("createSettingsPanel creates the refresh button, guidelines and chat switches, and rows per extension", () => {
  let refreshed = 0;
  let toggledGuidelines = null;
  const panel = createSettingsPanel({
    extensions: [
      { key: "roam-grid", name: "Roam Grid", toolCount: 24, readCount: 5, writeCount: 19 },
    ],
    onRefresh: () => { refreshed += 1; },
    onToggleGuidelines: (checked) => { toggledGuidelines = checked; },
  });

  assert.equal(panel.tabTitle, "Tool Hub");
  assert.deepEqual(panel.settings.map((row) => row.id), [
    "refresh-extensions",
    "guidelines-index-enabled",
    "chat-bridge-enabled",
    "chat-auto-load",
    extensionEnabledSettingId("roam-grid"),
    extensionWriteSettingId("roam-grid"),
    extensionChatAutoSettingId("roam-grid"),
  ]);
  assert.equal(panel.settings[0].action.type, "button");
  panel.settings[0].action.onClick();
  assert.equal(refreshed, 1);
  assert.equal(panel.settings[1].action.type, "switch");
  panel.settings[1].action.onChange({ target: { checked: true } });
  assert.equal(toggledGuidelines, true);
});

test("chat settings read their defaults: bridge off, auto-load on, per-extension approval off", async () => {
  const api = makeFakeSettingsApi();
  assert.equal(isChatBridgeEnabled(api), false);
  assert.equal(isChatAutoLoadEnabled(api), true);
  assert.equal(isChatAutoApproved(api, "roam-grid"), false);

  await api.settings.set("chat-bridge-enabled", "yes");
  assert.equal(isChatBridgeEnabled(api), false);
  await api.settings.set("chat-bridge-enabled", true);
  assert.equal(isChatBridgeEnabled(api), true);

  await api.settings.set("chat-auto-load", false);
  assert.equal(isChatAutoLoadEnabled(api), false);
  await api.settings.set("chat-auto-load", 0);
  assert.equal(isChatAutoLoadEnabled(api), true);

  await setChatAutoApproved(api, "roam-grid", true);
  assert.equal(isChatAutoApproved(api, "roam-grid"), true);
  assert.equal(isChatAutoApproved(api, "better-tasks"), false);
  assert.match(extensionChatAutoSettingId("a.b"), /^ext:a~2eb:chat-auto$/);

  const locked = makeFakeSettingsApi({ canSet: false });
  await setChatAutoApproved(locked, "roam-grid", true);
  assert.equal(locked.store.size, 0);
});

test("describeChatBridgeStatus gives one plain sentence per phase", () => {
  assert.equal(describeChatBridgeStatus(undefined), "Off.");
  assert.equal(describeChatBridgeStatus({ phase: "off" }), "Off.");
  assert.equal(
    describeChatBridgeStatus({ phase: "waiting" }),
    "On. Roam's assistant has not loaded in this window yet; open the AI chat once.",
  );
  assert.equal(describeChatBridgeStatus({ phase: "starting" }), "On. Starting.");
  assert.equal(describeChatBridgeStatus({ phase: "ready" }), "On. Attaches at the next chat turn.");
  assert.equal(
    describeChatBridgeStatus({ phase: "attached", tools: 12, extensions: 3 }),
    "On and attached: 12 tools from 3 extensions.",
  );
  assert.equal(
    describeChatBridgeStatus({ phase: "attached", tools: 1, extensions: 1, verified: true }),
    "On and attached: 1 tool from 1 extension. Confirmed in a chat turn.",
  );
  assert.equal(
    describeChatBridgeStatus({ phase: "failed", detail: "Roam's chat runtime changed: durable.hook is missing" }),
    "Turned itself off: Roam's chat runtime changed: durable.hook is missing.",
  );
});

test("createSettingsPanel orders the chat rows, hides the write-free switch, and adds native extension rows", () => {
  const toggles = [];
  const panel = createSettingsPanel({
    extensions: [
      { key: "readers", name: "Readers", toolCount: 2, readCount: 2, writeCount: 0 },
      { key: "roam-grid", name: "Roam Grid", toolCount: 2, readCount: 1, writeCount: 1 },
    ],
    nativeExtensions: [
      { key: "native:https://x.github.io/plexus-diagram/", name: "Plexus Diagram", toolCount: 2, readCount: 1, writeCount: 1 },
    ],
    chatStatus: { phase: "attached", tools: 3, extensions: 2 },
    onToggleExtension: (...args) => toggles.push(args),
    onToggleChatBridge: (checked) => toggles.push(["bridge", checked]),
    onToggleChatAutoLoad: (checked) => toggles.push(["autoload", checked]),
  });
  const byId = new Map(panel.settings.map((row) => [row.id, row]));

  const bridge = byId.get("chat-bridge-enabled");
  assert.equal(bridge.name, "Built-in chat bridge (experimental)");
  assert.match(bridge.description, /Status: On and attached: 3 tools from 2 extensions\.$/);
  bridge.action.onChange({ target: { checked: true } });
  byId.get("chat-auto-load").action.onChange({ target: { checked: false } });
  assert.equal(byId.get("chat-auto-load").name, "Chat: load matching tools automatically");

  assert.equal(byId.has(extensionChatAutoSettingId("readers")), false);
  const gridAuto = byId.get(extensionChatAutoSettingId("roam-grid"));
  assert.equal(gridAuto.name, "Roam Grid — chat may change the graph without asking");
  assert.match(gridAuto.description, /Skip the confirm dialog when the built-in chat runs a writing tool from roam-grid\. Tools that delete, or change things in bulk, still ask\. Default off\./);
  gridAuto.action.onChange({ target: { checked: true } });

  const nativeKey = "native:https://x.github.io/plexus-diagram/";
  assert.ok(byId.has(extensionEnabledSettingId(nativeKey)));
  assert.ok(byId.has(extensionWriteSettingId(nativeKey)));
  const nativeAuto = byId.get(extensionChatAutoSettingId(nativeKey));
  assert.match(nativeAuto.name, /^Plexus Diagram \(native AI tools\) — /);
  assert.match(nativeAuto.description, /Tools that delete, or change things in bulk, still ask\./);
  assert.match(nativeAuto.description, /built-in chat bridge only/);
  nativeAuto.action.onChange({ target: { checked: true } });

  assert.deepEqual(toggles, [
    ["bridge", true],
    ["autoload", false],
    ["roam-grid", "chatAuto", true],
    [nativeKey, "chatAuto", true],
  ]);
  const order = panel.settings.map((row) => row.id);
  assert.ok(order.indexOf("chat-bridge-enabled") < order.indexOf("chat-auto-load"));
  assert.ok(order.indexOf("chat-auto-load") < order.indexOf(extensionEnabledSettingId("readers")));
  assert.ok(order.indexOf(extensionChatAutoSettingId("roam-grid")) < order.indexOf(extensionEnabledSettingId(nativeKey)));
});
