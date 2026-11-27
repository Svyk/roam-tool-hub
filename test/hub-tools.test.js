import assert from "node:assert/strict";
import test from "node:test";

import { createHubTools, finalizeToolResult, HUB_TOOL_NAMES, registerHubTools } from "../src/hub-tools.js";
import { extensionEnabledSettingId, extensionWriteSettingId } from "../src/settings.js";

function makeFakeExtensionAPI() {
  const store = new Map();
  return {
    store,
    settings: {
      canSet: true,
      get: (key) => (store.has(key) ? store.get(key) : null),
      set: async (key, value) => {
        store.set(key, value);
        return null;
      },
    },
  };
}

function makeFakeRegistry() {
  const calls = [];
  const registry = {
    "roam-grid": {
      name: "Roam Grid",
      version: "0.18.7",
      tools: [
        {
          name: "rg_list_grids",
          readOnly: true,
          description: "List every enhanced grid with uid, mode, rows, cols.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: (args, ctx) => {
            calls.push({ tool: "rg_list_grids", args, tokenUserUid: ctx?.tokenUserUid ?? null });
            return { grids: [{ uid: "g1", rows: 3, cols: 2 }] };
          },
        },
        {
          name: "rg_set_cell",
          description: "Set a cell value in an enhanced grid.",
          parameters: {
            type: "object",
            required: ["uid", "row", "col", "value"],
            additionalProperties: false,
            properties: {
              uid: { type: "string", minLength: 1 },
              row: { type: "integer", minimum: 0 },
              col: { type: "integer", minimum: 0 },
              value: { type: "string" },
            },
          },
          execute: async (args, ctx) => {
            calls.push({ tool: "rg_set_cell", args, tokenUserUid: ctx?.tokenUserUid ?? null });
            await Promise.resolve();
            return { ok: true, uid: args.uid, value: args.value };
          },
        },
      ],
    },
    "better-tasks": {
      name: "Better Tasks",
      version: "1.3",
      tools: [
        {
          name: "bt_get_projects",
          readOnly: true,
          description: "List projects tracked by Better Tasks. " + "x".repeat(350),
          parameters: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["active", "completed", "archived"] },
            },
          },
          execute: (args) => {
            calls.push({ tool: "bt_get_projects", args });
            return { projects: ["Inbox"] };
          },
        },
        {
          name: "bt_boom",
          readOnly: true,
          description: "Always throws an error.",
          parameters: { type: "object", properties: {} },
          execute: () => {
            throw new Error("simulated boom");
          },
        },
        {
          name: "bt_async_boom",
          readOnly: true,
          description: "Always rejects asynchronously.",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            await Promise.resolve();
            throw new Error("async boom");
          },
        },
        {
          name: "bt_huge",
          readOnly: true,
          description: "Returns a huge payload.",
          parameters: { type: "object", properties: {} },
          execute: () => ({ blob: "Z".repeat(50_000) }),
        },
      ],
    },
  };
  return { registry, calls };
}

function toolsByName(tools) {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

test("registers the five spec tools with valid scopes and compact descriptions", () => {
  const api = makeFakeExtensionAPI();
  const { registry } = makeFakeRegistry();
  const tools = createHubTools({ extensionAPI: api, getRegistry: () => registry });

  assert.deepEqual(tools.map((t) => t.name), HUB_TOOL_NAMES);
  const map = toolsByName(tools);
  assert.equal(map.list_extensions.scope, "read");
  assert.equal(map.find_tools.scope, "read");
  assert.equal(map.describe_tools.scope, "read");
  assert.equal(map.run_read_tool.scope, "read");
  assert.equal(map.run_tool.scope, "edit");

  const totalSerializedSize = JSON.stringify(
    tools.map(({ name, scope, description, inputSchema }) => ({ name, scope, description, inputSchema })),
  ).length;
  assert.ok(totalSerializedSize < 2500, `Expected compact hub metadata (<2500 chars), got ${totalSerializedSize}`);
});

test("list_extensions, find_tools, and describe_tools follow discovery workflow and honor enabled switch", async () => {
  const api = makeFakeExtensionAPI();
  const { registry } = makeFakeRegistry();
  const map = toolsByName(createHubTools({ extensionAPI: api, getRegistry: () => registry }));

  const listed = map.list_extensions.handler();
  assert.equal(listed.totalExtensions, 2);
  assert.equal(listed.totalTools, 6);
  assert.deepEqual(listed.extensions.map((e) => e.key), ["better-tasks", "roam-grid"]);
  assert.equal(listed.extensions[1].readCount, 1);
  assert.equal(listed.extensions[1].writeCount, 1);
  assert.equal(listed.extensions[1].writeEnabled, false);

  const found = map.find_tools.handler({ extension: "grid", query: "cell" });
  assert.equal(found.totalMatched, 1);
  assert.equal(found.tools[0].id, "roam-grid/rg_set_cell");
  assert.equal(found.tools[0].readOnly, false);
  assert.equal("parameters" in found.tools[0], false);

  const foundTrunc = map.find_tools.handler({ extension: "better-tasks", query: "projects" });
  assert.equal(foundTrunc.tools[0].description.length, 300);

  const described = map.describe_tools.handler({
    tools: ["roam-grid/rg_set_cell", "missing/tool"],
  });
  assert.equal(described.tools.length, 1);
  assert.equal(described.tools[0].id, "roam-grid/rg_set_cell");
  assert.deepEqual(described.tools[0].parameters.required, ["uid", "row", "col", "value"]);
  assert.equal(described.errors.length, 1);
  assert.equal(described.errors[0].id, "missing/tool");

  // Disable roam-grid -> hidden from list, find, and describe.
  await api.settings.set(extensionEnabledSettingId("roam-grid"), false);
  assert.deepEqual(map.list_extensions.handler().extensions.map((e) => e.key), ["better-tasks"]);
  assert.equal(map.find_tools.handler({ extension: "grid" }).totalMatched, 0);
  const describedDisabled = map.describe_tools.handler({ tools: ["roam-grid/rg_list_grids"] });
  assert.equal(describedDisabled.tools.length, 0);
  assert.match(describedDisabled.errors[0].error, /disabled/i);
});

test("run_read_tool enforces readOnly: true, enabled switch, and schema validation", async () => {
  const api = makeFakeExtensionAPI();
  const { registry, calls } = makeFakeRegistry();
  const map = toolsByName(createHubTools({ extensionAPI: api, getRegistry: () => registry }));

  // Succeeds on readOnly tool.
  const ok = await map.run_read_tool.handler({ tool: "roam-grid/rg_list_grids" });
  assert.deepEqual(ok, { tool: "roam-grid/rg_list_grids", result: { grids: [{ uid: "g1", rows: 3, cols: 2 }] } });

  // Refuses writing tool even if write switch is turned on!
  await api.settings.set(extensionWriteSettingId("roam-grid"), true);
  const refusedWrite = await map.run_read_tool.handler({
    tool: "roam-grid/rg_set_cell",
    args: { uid: "g1", row: 0, col: 0, value: "x" },
  });
  assert.equal(refusedWrite.code, "read-only-required");
  assert.equal(calls.filter((c) => c.tool === "rg_set_cell").length, 0);

  // Refuses invalid schema args before calling execute.
  const badArgs = await map.run_read_tool.handler({
    tool: "better-tasks/bt_get_projects",
    args: { status: "bogus" },
  });
  assert.equal(badArgs.code, "validation-failed");
  assert.equal(calls.filter((c) => c.tool === "bt_get_projects").length, 0);

  // Refuses disabled extension.
  await api.settings.set(extensionEnabledSettingId("roam-grid"), false);
  const refusedDisabled = await map.run_read_tool.handler({ tool: "roam-grid/rg_list_grids" });
  assert.equal(refusedDisabled.code, "extension-disabled");
});

test("run_tool gates writing tools behind the per-extension write switch and attributes via context.asTokenUser", async () => {
  const api = makeFakeExtensionAPI();
  const { registry, calls } = makeFakeRegistry();
  const map = toolsByName(createHubTools({ extensionAPI: api, getRegistry: () => registry }));

  // Writing tool refused by default (write switch off).
  const blocked = await map.run_tool.handler({
    tool: "roam-grid/rg_set_cell",
    args: { uid: "g1", row: 0, col: 1, value: "hello" },
  });
  assert.equal(blocked.code, "write-disabled");
  assert.equal(calls.length, 0);

  // Enable writing tools for roam-grid, verify asTokenUser receives synchronous fn and promise awaited outside.
  await api.settings.set(extensionWriteSettingId("roam-grid"), true);
  let asTokenUserCalls = 0;
  let receivedAsyncFn = false;
  const fakeContext = {
    tokenUserUid: "ai-user-1",
    asTokenUser(fn) {
      asTokenUserCalls += 1;
      if (fn.constructor?.name === "AsyncFunction") receivedAsyncFn = true;
      return fn();
    },
  };

  const allowed = await map.run_tool.handler(
    { tool: "roam-grid/rg_set_cell", args: { uid: "g1", row: 0, col: 1, value: "hello" } },
    fakeContext,
  );
  assert.equal(asTokenUserCalls, 1);
  assert.equal(receivedAsyncFn, false);
  assert.deepEqual(allowed, {
    tool: "roam-grid/rg_set_cell",
    result: { ok: true, uid: "g1", value: "hello" },
  });
  assert.equal(calls[0].tokenUserUid, "ai-user-1");

  // Schema validation still blocks bad args on run_tool.
  const badWrite = await map.run_tool.handler(
    { tool: "roam-grid/rg_set_cell", args: { uid: "g1", row: -1, col: 0, value: "x" } },
    fakeContext,
  );
  assert.equal(badWrite.code, "validation-failed");
});

test("catches sync throws and async rejections with tool id, and caps huge results at 40 000 chars", async () => {
  const api = makeFakeExtensionAPI();
  const { registry } = makeFakeRegistry();
  const map = toolsByName(createHubTools({ extensionAPI: api, getRegistry: () => registry }));

  const syncErr = await map.run_read_tool.handler({ tool: "better-tasks/bt_boom" });
  assert.equal(syncErr.tool, "better-tasks/bt_boom");
  assert.equal(syncErr.code, "execution-error");
  assert.match(syncErr.error, /simulated boom/);

  const asyncErr = await map.run_read_tool.handler({ tool: "better-tasks/bt_async_boom" });
  assert.equal(asyncErr.tool, "better-tasks/bt_async_boom");
  assert.equal(asyncErr.code, "execution-error");
  assert.match(asyncErr.error, /async boom/);

  const huge = await map.run_read_tool.handler({ tool: "better-tasks/bt_huge" });
  assert.equal(huge.tool, "better-tasks/bt_huge");
  assert.equal(huge.truncated, true);
  assert.equal(huge.maxChars, 40_000);
  assert.ok(huge.originalChars > 50_000);
  assert.ok(huge.resultPreview.length > 35_000);
  assert.ok(JSON.stringify(huge).length <= 40_000, `Expected serialized result <= 40000, got ${JSON.stringify(huge).length}`);
  assert.match(huge.note, /truncated/i);

  // Quote-heavy JSON payload still fits the entire serialized envelope under maxChars.
  const quoteHeavy = finalizeToolResult("ext/quotes", { blob: '"'.repeat(30_000) }, 40_000);
  assert.equal(quoteHeavy.truncated, true);
  assert.ok(JSON.stringify(quoteHeavy).length <= 40_000, `Expected quote-heavy envelope <= 40000, got ${JSON.stringify(quoteHeavy).length}`);

  // Circular objects do not crash finalizeToolResult.
  const circular = {};
  circular.self = circular;
  const badJson = finalizeToolResult("ext/circ", circular);
  assert.equal(badJson.code, "serialization-error");
  assert.equal(badJson.tool, "ext/circ");
});

test("re-reads window.RoamExtensionTools live on each call without caching", () => {
  const api = makeFakeExtensionAPI();
  const registry = {};
  const map = toolsByName(createHubTools({ extensionAPI: api, getRegistry: () => registry }));

  assert.equal(map.list_extensions.handler().totalExtensions, 0);

  registry["late-ext"] = {
    name: "Late Extension",
    tools: [{ name: "ping", readOnly: true, description: "Ping.", execute: () => ({ pong: true }) }],
  };
  assert.equal(map.list_extensions.handler().totalExtensions, 1);
  assert.equal(map.find_tools.handler({ query: "ping" }).tools[0].id, "late-ext/ping");
});

test("preserves tool this-binding, rejects slash tool names, avoids surrogate splits, and rolls back partial addTool failure", async () => {
  const api = makeFakeExtensionAPI();
  const registry = {
    "ctx-ext": {
      name: "Ctx Ext",
      tools: [
        {
          name: "self_check",
          readOnly: true,
          tag: "bound-ok",
          description: "Checks this binding.",
          execute() {
            return { tag: this.tag };
          },
        },
        {
          name: "bad/slash",
          readOnly: true,
          description: "Should be skipped.",
          execute: () => ({}),
        },
      ],
    },
  };
  const map = toolsByName(createHubTools({ extensionAPI: api, getRegistry: () => registry }));
  assert.equal(map.find_tools.handler({}).totalMatched, 1);
  const res = await map.run_read_tool.handler({ tool: "ctx-ext/self_check" });
  assert.deepEqual(res, { tool: "ctx-ext/self_check", result: { tag: "bound-ok" } });

  // Surrogate pair at truncation boundary is not split into a lone surrogate
  const emojiPayload = "😀".repeat(20);
  const cut = finalizeToolResult("ext/emoji", emojiPayload, 10);
  assert.equal(cut.truncated, true);
  const lastCode = cut.resultPreview.charCodeAt(cut.resultPreview.length - 1);
  assert.equal(lastCode >= 0xd800 && lastCode <= 0xdbff, false);

  // Partial addTool failure cleans up earlier registered tools
  const removed = [];
  let count = 0;
  const failingApi = {
    ai: {
      addTool: ({ name }) => {
        count += 1;
        if (count === 3) throw new Error("boom");
        return name;
      },
      removeTool: ({ name }) => removed.push(name),
    },
  };
  assert.throws(() => registerHubTools(failingApi, Object.values(map)), /boom/);
  assert.equal(removed.length, 2);
});
