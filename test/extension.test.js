import assert from "node:assert/strict";
import test from "node:test";

import extension from "../src/extension.js";
import { HUB_TOOL_NAMES } from "../src/hub-tools.js";

function fakeExtensionApi() {
  const values = new Map();
  const calls = [];
  const registeredTools = new Map();
  return {
    calls,
    registeredTools,
    settings: {
      canSet: true,
      get: (key) => (values.has(key) ? values.get(key) : null),
      set: async (key, value) => {
        values.set(key, value);
        calls.push(["setting:set", key, value]);
        return null;
      },
      panel: {
        create: async (config) => {
          calls.push(["panel:create", config.tabTitle, config.settings.map((s) => s.id)]);
          return null;
        },
      },
    },
    ai: {
      addTool: (spec) => {
        registeredTools.set(spec.name, spec);
        calls.push(["ai:addTool", spec.name, spec.scope]);
        return null;
      },
      removeTool: ({ name }) => {
        registeredTools.delete(name);
        calls.push(["ai:removeTool", name]);
        return null;
      },
    },
    ui: {
      commandPalette: {
        addCommand: async ({ label }) => {
          calls.push(["command:add", label]);
          return null;
        },
        removeCommand: async ({ label }) => {
          calls.push(["command:remove", label]);
          return null;
        },
      },
    },
  };
}

test("extension registers five AI tools and at most one command palette entry, and survives repeated unload", async () => {
  assert.equal(typeof extension.onload, "function");
  assert.equal(typeof extension.onunload, "function");

  const api = fakeExtensionApi();
  const cleanup = await extension.onload({ extensionAPI: api, extension: { version: "0.1.0-test" } });
  assert.equal(typeof cleanup, "function");

  assert.deepEqual([...api.registeredTools.keys()], HUB_TOOL_NAMES);
  assert.equal(api.calls.filter(([name]) => name === "command:add").length, 1);

  await cleanup();
  await extension.onunload();
  await extension.onunload();

  assert.equal(api.registeredTools.size, 0);
  assert.equal(api.calls.filter(([name]) => name === "ai:removeTool").length, 5);
  assert.equal(api.calls.filter(([name]) => name === "command:remove").length, 1);
});

test("a second load disposes the previous runtime before registering again", async () => {
  const firstApi = fakeExtensionApi();
  const secondApi = fakeExtensionApi();

  await extension.onload({ extensionAPI: firstApi, extension: { version: "one" } });
  const cleanup = await extension.onload({ extensionAPI: secondApi, extension: { version: "two" } });

  assert.equal(firstApi.registeredTools.size, 0);
  assert.equal(firstApi.calls.filter(([name]) => name === "command:remove").length, 1);
  assert.equal(secondApi.registeredTools.size, 5);
  assert.equal(secondApi.calls.filter(([name]) => name === "command:add").length, 1);
  await cleanup();
});

test("onunload preserves the guidelines index block and stored uid", async () => {
  const api = fakeExtensionApi();
  await api.settings.set("guidelines-index-enabled", true);
  await api.settings.set("guidelines-block-uid", "owned-block-1");

  const cleanup = await extension.onload({ extensionAPI: api, extension: { version: "0.1.0-test" } });
  await cleanup();
  await extension.onunload();

  assert.equal(api.settings.get("guidelines-block-uid"), "owned-block-1");
});

test("the chat bridge setting seeds off, and loading with no window leaves the bridge detached", async () => {
  const api = fakeExtensionApi();
  const cleanup = await extension.onload({ extensionAPI: api, extension: { version: "0.4.0-test" } });
  assert.equal(api.settings.get("chat-bridge-enabled"), false);
  assert.equal(api.settings.get("chat-auto-load"), true);
  const [, , ids] = api.calls.filter(([name]) => name === "panel:create").at(-1);
  assert.ok(ids.includes("chat-bridge-enabled"));
  assert.ok(ids.includes("chat-auto-load"));
  await cleanup();
});

test("switching the bridge on without a Roam runtime waits quietly and unload turns it off", async () => {
  const api = fakeExtensionApi();
  await api.settings.set("chat-bridge-enabled", true);
  const priorWindow = globalThis.window;
  const win = {};
  globalThis.window = win;
  try {
    const cleanup = await extension.onload({ extensionAPI: api, extension: { version: "0.4.0-test" } });
    assert.equal(win.__roamToolHubChatBridge.status.phase, "waiting");
    assert.ok(Object.getOwnPropertyDescriptor(win, "PiHarness").set);
    await cleanup();
    assert.equal(win.__roamToolHubChatBridge.status.phase, "off");
    assert.equal("PiHarness" in win, false);
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});
