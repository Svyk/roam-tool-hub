import assert from "node:assert/strict";
import test from "node:test";

import {
  createSettingsPanel,
  encodeSettingKeySegment,
  extensionEnabledSettingId,
  extensionWriteSettingId,
  isExtensionEnabled,
  isExtensionWriteEnabled,
  seedExtensionDefaults,
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

  await api.settings.set(extensionEnabledSettingId("roam-grid"), false);
  await api.settings.set(extensionWriteSettingId("roam-grid"), true);
  assert.equal(isExtensionEnabled(api, "roam-grid"), false);
  assert.equal(isExtensionWriteEnabled(api, "roam-grid"), true);
});

test("createSettingsPanel creates refresh button, guidelines toggle, and two switches per extension", () => {
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
  assert.equal(panel.settings.length, 4);
  assert.equal(panel.settings[0].action.type, "button");
  panel.settings[0].action.onClick();
  assert.equal(refreshed, 1);
  assert.equal(panel.settings[1].action.type, "switch");
  panel.settings[1].action.onChange({ target: { checked: true } });
  assert.equal(toggledGuidelines, true);
  assert.equal(panel.settings[2].id, extensionEnabledSettingId("roam-grid"));
  assert.equal(panel.settings[3].id, extensionWriteSettingId("roam-grid"));
});
