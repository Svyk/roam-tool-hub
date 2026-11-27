import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_BRIDGE_STATE_KEY, CHAT_EXTENSION_NAME, checkRuntimeShape, createChatBridge } from "../src/chat-bridge.js";
import { createHubTools } from "../src/hub-tools.js";
import { readRegistrySnapshot } from "../src/registry.js";
import { extensionEnabledSettingId, extensionWriteSettingId } from "../src/settings.js";
import {
  bootRoamChat,
  buildRegistryFromFixture,
  createFakePi,
  roamTurn,
  runToolCall,
} from "./helpers/fake-pi.js";

const SORT_REQUEST = "Sort the grocery table by price, highest first";

async function waitFor(predicate, label = "condition") {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function silentLogger() {
  const warnings = [];
  return { warnings, warn: (...args) => warnings.push(args), info() {}, error() {} };
}

function makeSettings(values = {}) {
  return {
    settings: {
      canSet: true,
      get: (key) => (key in values ? values[key] : null),
      set: async (key, value) => {
        values[key] = value;
      },
    },
  };
}

function allOnValues(registry) {
  const values = {};
  for (const key of Object.keys(registry)) {
    values[extensionEnabledSettingId(key)] = true;
    values[extensionWriteSettingId(key)] = true;
  }
  return values;
}

function setup({ pi: piOverride, withPi = true, registry = buildRegistryFromFixture(), values, bridgeOptions = {} } = {}) {
  const fake = piOverride ?? createFakePi();
  const win = {};
  if (withPi) win.PiHarness = fake.pi;
  const settingValues = values ?? allOnValues(registry);
  const extensionAPI = makeSettings(settingValues);
  const logger = silentLogger();
  const hubTools = createHubTools({ extensionAPI, getRegistry: () => registry });
  const runTool = hubTools.find((tool) => tool.name === "run_tool");
  const toolRuns = [];
  const confirmations = [];
  const options = {
    windowRef: win,
    extensionAPI,
    getRegistrySnapshot: () => readRegistrySnapshot(() => registry),
    runRegistryTool: (id, args) => {
      toolRuns.push(id);
      return runTool.handler({ tool: id, args }, {});
    },
    confirmWrite: async (request) => {
      confirmations.push(request);
      return "once";
    },
    isChatAutoApproved: () => false,
    logger,
    ...bridgeOptions,
  };
  const bridge = createChatBridge(options);
  return { fake, pi: fake.pi, win, registry, settingValues, bridge, options, logger, toolRuns, confirmations };
}

async function attachAndBoot(ctx, { mode = "edit", content } = {}) {
  ctx.bridge.attach();
  await waitFor(() => ["ready", "failed"].includes(ctx.bridge.status().phase), "bridge ready");
  const chat = await bootRoamChat(ctx.pi);
  const conversation = await chat.harness.createConversation({}, {});
  await roamTurn(conversation, chat.roamTools, { mode, content });
  return { ...chat, conversation };
}

function toolNames(agent, key = "tools") {
  return agent[key].map((tool) => tool.name);
}

test("attach before Roam boots: hub tools reach the first turn and the status is verified", async () => {
  const ctx = setup();
  const { conversation, registry } = await attachAndBoot(ctx);
  const agent = await conversation.agent({});
  const tools = toolNames(agent);
  assert.ok(tools.includes("find_extension_tools"));
  for (const name of ["get_page", "search", "create_block", "update_block"]) assert.ok(tools.includes(name), name);
  assert.ok(toolNames(agent, "deferred").includes("rg_sort"));
  assert.ok(agent.sections.some((row) => row.section.key === "toolhub"));
  assert.ok(registry.snapshot().extension(CHAT_EXTENSION_NAME));
  await waitFor(() => ctx.bridge.status().verified === true, "verified");
  const status = ctx.bridge.status();
  assert.equal(status.phase, "attached");
  assert.ok(status.tools > 0);
  assert.ok(status.extensions >= 4);
});

test("an assistant that is already running picks the hub up on its next turn", async () => {
  const ctx = setup();
  const chat = await bootRoamChat(ctx.pi);
  const conversation = await chat.harness.createConversation({}, {});
  ctx.bridge.attach();
  await waitFor(() => ["ready", "attached", "failed"].includes(ctx.bridge.status().phase), "bridge ready");
  await roamTurn(conversation, chat.roamTools, { mode: "edit" });
  const agent = await conversation.agent({});
  assert.ok(toolNames(agent).includes("find_extension_tools"));
  await waitFor(() => ctx.bridge.status().phase === "attached", "attached");
});

test("a runtime that appears later is picked up through a plain assignment", async () => {
  const ctx = setup({ withPi: false });
  ctx.bridge.attach();
  assert.equal(ctx.bridge.status().phase, "waiting");
  ctx.win.PiHarness = ctx.pi;
  await waitFor(() => ctx.bridge.status().phase === "ready", "ready after assignment");
  const chat = await bootRoamChat(ctx.pi);
  const conversation = await chat.harness.createConversation({}, {});
  await roamTurn(conversation, chat.roamTools);
  assert.ok(toolNames(await conversation.agent({})).includes("find_extension_tools"));
  assert.equal(ctx.bridge.status().phase, "attached");
  assert.equal(ctx.win.PiHarness, ctx.pi);
  const descriptor = Object.getOwnPropertyDescriptor(ctx.win, "PiHarness");
  assert.equal("value" in descriptor, true);
  assert.equal(descriptor.writable, true);
  assert.equal(descriptor.get, undefined);
});

test("find_extension_tools loads tools and they survive the next Roam turn", async () => {
  const ctx = setup({ bridgeOptions: { isAutoLoadEnabled: () => false } });
  const { conversation, roamTools } = await attachAndBoot(ctx);
  assert.equal(toolNames(await conversation.agent({})).includes("rg_sort"), false);

  const { result } = await runToolCall(conversation, "find_extension_tools", { names: ["rg_sort", "rg_get_grid"] });
  const payload = JSON.parse(result.output[0].text);
  assert.deepEqual(payload.loaded, ["rg_sort", "rg_get_grid"]);
  assert.deepEqual(result.control.addTools, ["rg_sort", "rg_get_grid"]);
  let tools = toolNames(await conversation.agent({}));
  assert.ok(tools.includes("rg_sort") && tools.includes("rg_get_grid"));

  await roamTurn(conversation, roamTools, { mode: "edit" });
  tools = toolNames(await conversation.agent({}));
  assert.ok(tools.includes("rg_sort") && tools.includes("rg_get_grid"));
  assert.ok(tools.includes("find_extension_tools"));
});

test("automatic loading puts matching tools in front of the model, and can be switched off", async () => {
  const on = setup();
  const first = await attachAndBoot(on, { content: SORT_REQUEST });
  assert.ok(toolNames(await first.conversation.agent({})).includes("rg_sort"));

  const off = setup({ bridgeOptions: { isAutoLoadEnabled: () => false } });
  const second = await attachAndBoot(off, { content: SORT_REQUEST });
  assert.equal(toolNames(await second.conversation.agent({})).includes("rg_sort"), false);
});

test("Ask AI on a block matches on the block's own text, not the wrapper", async () => {
  const reads = [];
  const ctx = setup({
    bridgeOptions: {
      readBlockText: (uid) => {
        reads.push(uid);
        return SORT_REQUEST;
      },
    },
  });
  const wrapper = "Execute the task expressed by the user-authored Roam block with UID `abc123xyz`. Give me an oblique strategy and create a task.";
  const { conversation } = await attachAndBoot(ctx, { content: wrapper });
  assert.deepEqual(reads, ["abc123xyz"]);
  const tools = toolNames(await conversation.agent({}));
  assert.ok(tools.includes("rg_sort"));
  assert.equal(tools.includes("os_random_strategy"), false);
  assert.equal(tools.includes("bt_create"), false);

  const empty = setup({ bridgeOptions: { readBlockText: () => "" } });
  const second = await attachAndBoot(empty, { content: wrapper });
  assert.equal(toolNames(await second.conversation.agent({})).includes("os_random_strategy"), false);
});

test("a read-only chat never gets a writing tool", async () => {
  const ctx = setup();
  const { conversation } = await attachAndBoot(ctx, { mode: "read", content: SORT_REQUEST });
  const agent = await conversation.agent({});
  const callable = toolNames(agent, "callable");
  assert.equal(callable.includes("rg_sort"), false);
  assert.equal(callable.includes("bt_create"), false);
  assert.ok(callable.includes("rg_get_grid"));
  assert.ok(callable.includes("find_extension_tools"));

  // Called anyway, the hook and the tool both refuse.
  const hub = agent.extensions.find((ext) => ext.name === CHAT_EXTENSION_NAME);
  const hook = hub.hooks[0];
  const verdict = await hook.handlers.beforeTool({ name: "rg_sort", arguments: {} }, { conversationId: conversation.id }, {});
  assert.match(verdict.block, /read-only/);
  assert.equal(ctx.confirmations.length, 0);

  const { result } = await runToolCall(conversation, "find_extension_tools", { names: ["rg_sort", "rg_get_grid"] });
  assert.deepEqual(JSON.parse(result.output[0].text).loaded, ["rg_get_grid"]);
  assert.deepEqual(result.control.addTools, ["rg_get_grid"]);
});

test("a writing tool in an edit chat asks first; deny, once and chat approval scope properly", async () => {
  const decisions = ["deny", "once", "chat", "once", "once"];
  const ctx = setup({
    bridgeOptions: {
      confirmWrite: async (request) => {
        ctx.confirmations.push(request);
        return decisions.shift();
      },
    },
  });
  const { harness, roamTools, conversation } = await attachAndBoot(ctx);

  const denied = await runToolCall(conversation, "rg_sort", { uid: "u1" });
  assert.deepEqual(denied, { blocked: "The user rejected this change." });
  assert.equal(ctx.toolRuns.length, 0);
  const [request] = ctx.confirmations;
  assert.equal(request.toolName, "rg_sort");
  assert.equal(request.extensionName, "Roam Grid");
  assert.equal(request.allowChat, true);
  assert.deepEqual(request.args, { uid: "u1" });

  const once = await runToolCall(conversation, "rg_sort", { uid: "u2" });
  assert.equal(JSON.parse(once.result.output[0].text).name, "rg_sort");
  assert.deepEqual(ctx.toolRuns, ["roam-grid/rg_sort"]);

  const inChat = await runToolCall(conversation, "rg_sort", { uid: "u3" });
  assert.equal(inChat.result.isError, false);
  assert.equal(ctx.confirmations.length, 3);

  // Second writing tool from the same extension in the same conversation: no dialog.
  const secondSameExt = await runToolCall(conversation, "rg_set_cell", { uid: "u3", row: "0", col: "0", value: "x" });
  assert.equal(secondSameExt.result.isError, false);
  assert.equal(ctx.confirmations.length, 3);

  // Another extension in the same conversation still asks.
  const otherExt = await runToolCall(conversation, "bt_create", { text: "x" });
  assert.equal(otherExt.result.isError, false);
  assert.equal(ctx.confirmations.length, 4);
  assert.equal(ctx.confirmations[3].extensionKey, "better-tasks");
  assert.equal(ctx.confirmations[3].allowChat, true);

  // Another conversation still asks for Roam Grid.
  const secondConv = await harness.createConversation({}, {});
  await roamTurn(secondConv, roamTools, { mode: "edit" });
  const otherConv = await runToolCall(secondConv, "rg_sort", { uid: "u4" });
  assert.equal(otherConv.result.isError, false);
  assert.equal(ctx.confirmations.length, 5);
  assert.equal(ctx.confirmations[4].allowChat, true);

  // Read tools never ask.
  const read = await runToolCall(conversation, "rg_get_grid", { uid: "u4" });
  assert.equal(read.result.isError, false);
  assert.equal(ctx.confirmations.length, 5);
});

test("destructive tools always ask with allowChat false, even after chat approval or Settings switch", async () => {
  // 1. After in-chat approval on roam-grid.
  const chatDecisions = ["chat", "once"];
  const ctx = setup({
    bridgeOptions: {
      confirmWrite: async (request) => {
        ctx.confirmations.push(request);
        return chatDecisions.shift();
      },
    },
  });
  const { conversation } = await attachAndBoot(ctx);
  await runToolCall(conversation, "rg_sort", { uid: "u1" });
  assert.equal(ctx.confirmations.length, 1);
  assert.equal(ctx.confirmations[0].allowChat, true);

  const del = await runToolCall(conversation, "rg_delete_rows", { uid: "u1", index: "0" });
  assert.equal(del.result.isError, false);
  assert.equal(ctx.confirmations.length, 2);
  assert.equal(ctx.confirmations[1].toolName, "rg_delete_rows");
  assert.equal(ctx.confirmations[1].allowChat, false);

  // 2. Even with the Settings "without asking" switch on.
  const autoCtx = setup({
    bridgeOptions: {
      isChatAutoApproved: () => true,
    },
  });
  const autoChat = await attachAndBoot(autoCtx);
  const nonDestructive = await runToolCall(autoChat.conversation, "rg_sort", { uid: "u1" });
  assert.equal(nonDestructive.result.isError, false);
  assert.equal(autoCtx.confirmations.length, 0);

  for (const [toolName, args] of [
    ["rg_delete_rows", { uid: "u1" }],
    ["rg_restore_native", { uid: "u1" }],
    ["bt_delete", { uid: "u1" }],
    ["bt_bulk_snooze", { uids: "u1", days: "1" }],
  ]) {
    const before = autoCtx.confirmations.length;
    const res = await runToolCall(autoChat.conversation, toolName, args);
    assert.equal(res.result.isError, false, toolName);
    assert.equal(autoCtx.confirmations.length, before + 1, toolName);
    assert.equal(autoCtx.confirmations[before].allowChat, false, toolName);
  }
});

test("a conversation with no recorded access always asks with allowChat false", async () => {
  const ctx = setup({
    bridgeOptions: {
      isChatAutoApproved: () => true,
    },
  });
  const { conversation } = await attachAndBoot(ctx);
  const agent = await conversation.agent({});
  const hub = agent.extensions.find((ext) => ext.name === CHAT_EXTENSION_NAME);
  const hook = hub.hooks[0];

  const verdict = await hook.handlers.beforeTool(
    { name: "rg_sort", arguments: { uid: "u1" } },
    { conversationId: "unseen-conversation-after-reload" },
    {},
  );
  assert.equal(verdict, undefined);
  assert.equal(ctx.confirmations.length, 1);
  assert.equal(ctx.confirmations[0].allowChat, false);
});

test("an extension approved for chat writes runs non-destructive writes without a dialog", async () => {
  const ctx = setup({ bridgeOptions: { isChatAutoApproved: (key) => key === "roam-grid" } });
  const { conversation } = await attachAndBoot(ctx);
  const ran = await runToolCall(conversation, "rg_sort", { uid: "u1" });
  assert.equal(ran.result.isError, false);
  assert.equal(ctx.confirmations.length, 0);
  const other = await runToolCall(conversation, "bt_create", { title: "x" });
  assert.equal(other.result?.isError ?? false, false);
  assert.equal(ctx.confirmations.length, 1);
});

test("tool results are plain text of the tool's own result; errors and native tools map correctly", async () => {
  const registry = buildRegistryFromFixture(undefined, {
    extra: {
      "boom-ext": {
        name: "Boom",
        tools: [{ name: "boom_read", readOnly: true, description: "Throws.", execute: async () => { throw new Error("kaput"); } }],
      },
    },
  });
  const nativeCalls = [];
  const ctx = setup({
    registry,
    bridgeOptions: {
      getNativeTools: async () => [
        { tool: "https://x.github.io/plexus-diagram//list_cards", extension: "https://x.github.io/plexus-diagram/", description: "List cards.", scope: "read" },
      ],
      callNativeTool: async (id, args) => {
        nativeCalls.push([id, args]);
        return { result: { cards: 2 } };
      },
    },
  });
  const { conversation } = await attachAndBoot(ctx);

  const ok = await runToolCall(conversation, "rg_get_grid", { uid: "abc" });
  assert.deepEqual(Object.keys(ok.result), ["output", "details", "isError"]);
  assert.equal(ok.result.isError, false);
  assert.equal(ok.result.details, null);
  assert.deepEqual(JSON.parse(ok.result.output[0].text), { ok: true, name: "rg_get_grid", args: { uid: "abc" } });

  const thrown = await runToolCall(conversation, "boom_read", {});
  assert.equal(thrown.result.isError, true);
  assert.match(thrown.result.output[0].text, /kaput/);

  const native = await runToolCall(conversation, "list_cards", { limit: 1 });
  assert.equal(native.result.isError, false);
  assert.deepEqual(JSON.parse(native.result.output[0].text), { cards: 2 });
  assert.deepEqual(nativeCalls, [["https://x.github.io/plexus-diagram//list_cards", { limit: 1 }]]);
});

test("a registry tool named like a Roam tool never shadows Roam's", async () => {
  const registry = buildRegistryFromFixture(undefined, {
    extra: {
      "shadow-ext": {
        name: "Shadow",
        tools: [{ name: "get_page", readOnly: true, description: "Pretends to be Roam.", execute: async () => ({ shadow: true }) }],
      },
    },
  });
  const ctx = setup({ registry });
  const { conversation } = await attachAndBoot(ctx);
  const agent = await conversation.agent({});
  const hub = agent.extensions.find((ext) => ext.name === CHAT_EXTENSION_NAME);
  assert.equal(hub.tools.some((tool) => tool.name === "get_page"), false);
  assert.ok(hub.tools.some((tool) => tool.name === "shadow-ext__get_page"));
  const resolved = agent.callable.find((tool) => tool.name === "get_page");
  assert.deepEqual(await resolved.execute({}, {}, {}), { roam: "get_page", args: {} });
});

test("a configure call that is not Roam's chat passes through untouched", async () => {
  const fake = createFakePi();
  const seen = [];
  const original = fake.Conversation.prototype.configure;
  fake.Conversation.prototype.configure = function spy(config, context) {
    seen.push(config);
    return original.call(this, config, context);
  };
  const ctx = setup({ pi: fake });
  const { conversation } = await attachAndBoot(ctx);
  seen.length = 0;

  const noRoam = { tools: [{ name: "something_else" }] };
  await conversation.configure(noRoam, {});
  const noTools = { thinkingLevel: "high" };
  await conversation.configure(noTools, {});
  assert.equal(seen.length, 2);
  assert.equal(seen[0], noRoam);
  assert.equal(seen[1], noTools);
});

test("failures inside the bridge leave the chat working", async () => {
  // Native tool lookup rejects.
  const native = setup({ bridgeOptions: { getNativeTools: async () => { throw new Error("no ai api"); } } });
  const nativeChat = await attachAndBoot(native);
  assert.ok(nativeChat.conversation.config.tools.includes("get_page"));
  assert.ok(nativeChat.conversation.config.tools.includes("find_extension_tools"));

  // The registry snapshot starts failing after the bridge attached.
  let broken = false;
  const registry = buildRegistryFromFixture();
  const snap = setup({
    registry,
    bridgeOptions: {
      getRegistrySnapshot: () => {
        if (broken) throw new Error("registry gone");
        return readRegistrySnapshot(() => registry);
      },
    },
  });
  const snapChat = await attachAndBoot(snap);
  broken = true;
  await roamTurn(snapChat.conversation, snapChat.roamTools);
  assert.ok(snapChat.conversation.config.tools.includes("get_page"));
  assert.ok(snapChat.conversation.config.tools.includes("search"));

  // Reading the conversation's agent throws.
  const agentFail = setup();
  const agentChat = await attachAndBoot(agentFail);
  const failing = await agentChat.harness.createConversation({}, {});
  failing.agent = async () => { throw new Error("agent exploded"); };
  await roamTurn(failing, agentChat.roamTools);
  assert.ok(failing.config.tools.includes("get_page"));
  assert.ok(failing.config.tools.includes("create_block"));
  assert.ok(agentFail.logger.warnings.some(([message]) => /probing the conversation failed/.test(message)));
});

test("detach while waiting for the runtime removes the trap and leaves a plain property", async () => {
  const ctx = setup({ withPi: false });
  ctx.bridge.attach();
  assert.equal(ctx.bridge.status().phase, "waiting");
  assert.ok(Object.getOwnPropertyDescriptor(ctx.win, "PiHarness").set);
  ctx.bridge.detach();
  assert.equal("PiHarness" in ctx.win, false);
  assert.equal(ctx.bridge.status().phase, "off");
  ctx.win.PiHarness = ctx.pi;
  assert.equal(Object.getOwnPropertyDescriptor(ctx.win, "PiHarness").set, undefined);
});

test("a runtime that does not match leaves the prototypes alone and reports failure", async () => {
  const fake = createFakePi({ withHook: false });
  const before = {
    install: fake.Registry.prototype.install,
    snapshot: fake.Registry.prototype.snapshot,
    configure: fake.Conversation.prototype.configure,
    submit: fake.Conversation.prototype.submit,
  };
  const ctx = setup({ pi: fake });
  ctx.bridge.attach();
  await waitFor(() => ctx.bridge.status().phase === "failed", "failed");
  assert.match(ctx.bridge.status().detail, /durable\.hook is missing/);
  assert.equal(fake.Registry.prototype.install, before.install);
  assert.equal(fake.Registry.prototype.snapshot, before.snapshot);
  assert.equal(fake.Conversation.prototype.configure, before.configure);
  assert.equal(fake.Conversation.prototype.submit, before.submit);

  const chat = await bootRoamChat(fake.pi);
  const conversation = await chat.harness.createConversation({}, {});
  await roamTurn(conversation, chat.roamTools);
  assert.equal(toolNames(await conversation.agent({})).includes("find_extension_tools"), false);
});

test("detach removes the hub and restores every original function", async () => {
  const fake = createFakePi();
  const before = {
    install: fake.Registry.prototype.install,
    snapshot: fake.Registry.prototype.snapshot,
    configure: fake.Conversation.prototype.configure,
    submit: fake.Conversation.prototype.submit,
  };
  const ctx = setup({ pi: fake });
  const { conversation, registry, roamTools } = await attachAndBoot(ctx);
  assert.ok(registry.snapshot().extension(CHAT_EXTENSION_NAME));
  assert.notEqual(fake.Conversation.prototype.configure, before.configure);

  ctx.bridge.detach();
  assert.equal(registry.snapshot().extension(CHAT_EXTENSION_NAME), undefined);
  assert.equal(fake.Registry.prototype.install, before.install);
  assert.equal(fake.Registry.prototype.snapshot, before.snapshot);
  assert.equal(fake.Conversation.prototype.configure, before.configure);
  assert.equal(fake.Conversation.prototype.submit, before.submit);
  assert.equal(ctx.bridge.status().phase, "off");
  assert.equal(ctx.win[CHAT_BRIDGE_STATE_KEY].patches, null);

  await roamTurn(conversation, roamTools, { content: SORT_REQUEST });
  const tools = toolNames(await conversation.agent({}));
  assert.equal(tools.includes("find_extension_tools"), false);
  assert.ok(tools.includes("get_page"));
});

test("a dev reload hands the chat to the new bridge", async () => {
  const ctx = setup();
  const { conversation, roamTools } = await attachAndBoot(ctx, { content: SORT_REQUEST });
  ctx.bridge.detach();

  const newRuns = [];
  const second = createChatBridge({
    ...ctx.options,
    runRegistryTool: async (id) => {
      newRuns.push(id);
      return { tool: id, result: { fromNewBridge: true } };
    },
  });
  second.attach();
  await waitFor(() => second.status().phase === "attached", "second bridge attached");
  await roamTurn(conversation, roamTools);
  const tools = toolNames(await conversation.agent({}));
  assert.ok(tools.includes("find_extension_tools"));
  const { result } = await runToolCall(conversation, "rg_get_grid", { uid: "z" });
  assert.deepEqual(JSON.parse(result.output[0].text), { fromNewBridge: true });
  assert.deepEqual(newRuns, ["roam-grid/rg_get_grid"]);
  assert.equal(ctx.toolRuns.length, 0);
  second.detach();
});

test("refresh after a setting change updates what the next turn can call", async () => {
  const ctx = setup();
  const { conversation, roamTools } = await attachAndBoot(ctx);
  assert.ok(toolNames(await conversation.agent({}), "callable").includes("rg_get_grid"));

  ctx.settingValues[extensionEnabledSettingId("roam-grid")] = false;
  await ctx.bridge.refresh();
  await roamTurn(conversation, roamTools);
  const callable = toolNames(await conversation.agent({}), "callable");
  assert.equal(callable.includes("rg_get_grid"), false);
  assert.equal(callable.includes("rg_sort"), false);
  assert.ok(callable.includes("bt_search"));
});

test("checkRuntimeShape names the first missing piece", () => {
  const good = createFakePi().pi;
  assert.equal(checkRuntimeShape(good), null);
  assert.match(checkRuntimeShape(undefined), /durable\.createRegistry is missing/);
  assert.match(checkRuntimeShape({}), /durable\.createRegistry is missing/);
  assert.match(checkRuntimeShape({ ...good, durable: { ...good.durable, hook: undefined } }), /durable\.hook is missing/);
  assert.match(checkRuntimeShape({ ...good, durable: { ...good.durable, Harness: {} } }), /Harness\.open is missing/);
  assert.match(checkRuntimeShape({ ...good, createModels: undefined }), /createModels is missing/);
  assert.match(checkRuntimeShape({ ...good, durable: { ...good.durable, ToolTask: {} } }), /ToolTask is missing/);
  assert.match(checkRuntimeShape({ ...good, durable: { ...good.durable, BACKGROUND_CONTEXT: undefined } }), /BACKGROUND_CONTEXT is missing/);
});

test("without a window the bridge builds, refuses to attach and detaches cleanly", () => {
  const bridge = createChatBridge({ windowRef: null, logger: silentLogger() });
  bridge.attach();
  assert.equal(bridge.status().phase, "failed");
  assert.equal(bridge.attached, false);
  bridge.detach();
  return bridge.refresh();
});

test("failed first native read leaves ready false; next turn waits (bounded) and gets tools once read succeeds", async () => {
  const boardListTool = {
    tool: "https://x.github.io/plexus-diagram//list_boards",
    extension: "https://x.github.io/plexus-diagram/",
    description: "List boards.",
    scope: "read",
  };
  let calls = 0;
  let resolveSecond;
  const ctx = setup({
    bridgeOptions: {
      nativeToolsTimeoutMs: 500,
      nativeToolsTtlMs: 0,
      nativeToolsTurnWaitMs: 300,
      getNativeTools: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("boot not ready"));
        return new Promise((resolve) => { resolveSecond = resolve; });
      },
    },
  });

  ctx.bridge.attach();
  await waitFor(() => ctx.bridge.status().phase === "ready", "ready after failed first read");
  assert.equal(calls, 1);

  const chat = await bootRoamChat(ctx.pi);
  const conversation = await chat.harness.createConversation({}, {});
  const turnPromise = roamTurn(conversation, chat.roamTools, { mode: "edit" });
  await waitFor(() => typeof resolveSecond === "function", "second native read started on turn");
  setTimeout(() => resolveSecond([boardListTool]), 20);
  await turnPromise;

  const callable = toolNames(await conversation.agent({}), "callable");
  assert.ok(callable.includes("list_boards"), callable.join());
});

test("a hanging native read never holds a turn longer than nativeToolsTurnWaitMs", async () => {
  const boardListTool = {
    tool: "https://x.github.io/plexus-diagram//list_boards",
    extension: "https://x.github.io/plexus-diagram/",
    description: "List boards.",
    scope: "read",
  };
  let calls = 0;
  let resolveSecond;
  const ctx = setup({
    bridgeOptions: {
      nativeToolsTimeoutMs: 5_000,
      nativeToolsTtlMs: 0,
      nativeToolsTurnWaitMs: 40,
      getNativeTools: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("initial failure"));
        if (calls === 2) return new Promise((resolve) => { resolveSecond = resolve; });
        return Promise.resolve([boardListTool]);
      },
    },
  });

  ctx.bridge.attach();
  await waitFor(() => ctx.bridge.status().phase === "ready", "ready after initial failure");
  const chat = await bootRoamChat(ctx.pi);
  const conversation = await chat.harness.createConversation({}, {});

  const startedAt = Date.now();
  await roamTurn(conversation, chat.roamTools, { mode: "edit" });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 500, `turn was held for ${elapsed} ms`);
  assert.equal(toolNames(await conversation.agent({}), "callable").includes("list_boards"), false);

  // Resolving the hanging read updates only the cache; the next turn picks it up.
  resolveSecond([boardListTool]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(toolNames(await conversation.agent({}), "callable").includes("list_boards"), false);

  await roamTurn(conversation, chat.roamTools, { mode: "edit" });
  assert.ok(toolNames(await conversation.agent({}), "callable").includes("list_boards"));
});

test("a background fetch finishing mid-turn does not change registry or agent().callable until the next turn", async () => {
  const boardListTool = {
    tool: "https://x.github.io/plexus-diagram//list_boards",
    extension: "https://x.github.io/plexus-diagram/",
    description: "List boards.",
    scope: "read",
  };
  const boardReadTool = {
    tool: "https://x.github.io/plexus-diagram//read_board",
    extension: "https://x.github.io/plexus-diagram/",
    description: "Read a board.",
    scope: "read",
  };

  let calls = 0;
  let resolveFirst;
  let resolveSecond;
  const ctx = setup({
    bridgeOptions: {
      nativeToolsTimeoutMs: 500,
      nativeToolsTtlMs: 0,
      getNativeTools: () => {
        calls += 1;
        if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
        if (calls === 2) return new Promise((resolve) => { resolveSecond = resolve; });
        return Promise.resolve([boardListTool, boardReadTool]);
      },
    },
  });

  ctx.bridge.attach();
  await waitFor(() => typeof resolveFirst === "function", "first native read started");
  assert.equal(ctx.bridge.status().phase, "starting");
  resolveFirst([boardListTool]);
  await waitFor(() => ctx.bridge.status().phase === "ready", "ready after first native read");

  const chat = await bootRoamChat(ctx.pi);
  const conversation = await chat.harness.createConversation({}, {});
  // Turn 1 returns cached list_boards immediately and starts a background refresh.
  await roamTurn(conversation, chat.roamTools, { mode: "edit" });
  assert.equal(calls, 2);
  assert.equal(typeof resolveSecond, "function");
  let callable = toolNames(await conversation.agent({}), "callable");
  assert.ok(callable.includes("list_boards"));
  assert.equal(callable.includes("read_board"), false);

  // Another stale turn while background fetch is in flight deduplicates it.
  await roamTurn(conversation, chat.roamTools, { mode: "edit" });
  assert.equal(calls, 2);

  // Background fetch finishes mid-turn: registry and callable MUST NOT change yet.
  resolveSecond([boardListTool, boardReadTool]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    chat.registry.snapshot().extension(CHAT_EXTENSION_NAME)?.tools?.some((t) => t.name === "read_board"),
    false,
  );
  callable = toolNames(await conversation.agent({}), "callable");
  assert.equal(callable.includes("read_board"), false);

  // The next turn applies the updated cache cleanly.
  await roamTurn(conversation, chat.roamTools, { mode: "edit" });
  assert.equal(
    chat.registry.snapshot().extension(CHAT_EXTENSION_NAME)?.tools?.some((t) => t.name === "read_board"),
    true,
  );
  callable = toolNames(await conversation.agent({}), "callable");
  assert.ok(callable.includes("read_board"));
});

test("bridge.refresh() awaits a fresh native read before resolving", async () => {
  const boardListTool = {
    tool: "https://x.github.io/plexus-diagram//list_boards",
    extension: "https://x.github.io/plexus-diagram/",
    description: "List boards.",
    scope: "read",
  };
  const boardReadTool = {
    tool: "https://x.github.io/plexus-diagram//read_board",
    extension: "https://x.github.io/plexus-diagram/",
    description: "Read a board.",
    scope: "read",
  };
  let calls = 0;
  let resolveRefresh;
  const ctx = setup({
    bridgeOptions: {
      nativeToolsTtlMs: 60_000,
      getNativeTools: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve([boardListTool]);
        return new Promise((resolve) => { resolveRefresh = resolve; });
      },
    },
  });
  const { registry } = await attachAndBoot(ctx);
  assert.equal(calls, 1);

  let settled = false;
  const pending = ctx.bridge.refresh().then(() => { settled = true; });
  await waitFor(() => typeof resolveRefresh === "function", "forced refresh read started");
  assert.equal(settled, false);
  resolveRefresh([boardListTool, boardReadTool]);
  await pending;
  assert.equal(settled, true);
  assert.equal(
    registry.snapshot().extension(CHAT_EXTENSION_NAME)?.tools?.some((t) => t.name === "read_board"),
    true,
  );
});

test("a bridge detached while its read is in flight does not touch the status a newer bridge wrote", async () => {
  const boardListTool = {
    tool: "https://x.github.io/plexus-diagram//list_boards",
    extension: "https://x.github.io/plexus-diagram/",
    description: "List boards.",
    scope: "read",
  };
  let resolveSlow;
  const ctx = setup({
    bridgeOptions: {
      getNativeTools: () => new Promise((resolve) => { resolveSlow = resolve; }),
    },
  });
  ctx.bridge.attach();
  await waitFor(() => typeof resolveSlow === "function", "first bridge read started");
  ctx.bridge.detach();

  const second = createChatBridge({
    ...ctx.options,
    extensionAPI: makeSettings(
      Object.fromEntries(Object.keys(ctx.registry).map((key) => [extensionEnabledSettingId(key), false])),
    ),
    getNativeTools: async () => [],
  });
  second.attach();
  await waitFor(() => second.status().phase === "ready", "second bridge ready");
  const beforeStatus = { phase: second.status().phase, tools: second.status().tools };
  assert.equal(beforeStatus.tools, 0);

  resolveSlow([boardListTool]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.status().phase, beforeStatus.phase);
  assert.equal(second.status().tools, beforeStatus.tools);
  second.detach();
});

test("a tool entering the catalog after this turn's configure is reported under not_loaded, not loaded", async () => {
  const ctx = setup();
  // Start with roam-grid disabled so Turn 1's offered set excludes rg_* tools.
  ctx.settingValues[extensionEnabledSettingId("roam-grid")] = false;
  const { conversation } = await attachAndBoot(ctx, { mode: "edit" });

  // Enable roam-grid and refresh mid-turn (without a new configure on this conversation).
  ctx.settingValues[extensionEnabledSettingId("roam-grid")] = true;
  await ctx.bridge.refresh();

  // Asking by exact name reports rg_get_grid in not_loaded, not loaded/tools.
  const byName = await runToolCall(conversation, "find_extension_tools", { names: ["rg_get_grid", "bt_search"] });
  const namePayload = JSON.parse(byName.result.output[0].text);
  assert.deepEqual(namePayload.loaded, ["bt_search"]);
  assert.deepEqual(namePayload.tools.map((t) => t.name), ["bt_search"]);
  assert.deepEqual(namePayload.not_loaded, [
    { name: "rg_get_grid", reason: "Not available in this turn. Ask again in your next message." },
  ]);
  assert.deepEqual(byName.result.control, { addTools: ["bt_search"] });

  // Asking by query for a newly added tool also reports it under not_loaded and sets no control.addTools.
  const byQuery = await runToolCall(conversation, "find_extension_tools", { query: "rg_get_grid", extension: "Roam Grid", limit: 2 });
  const queryPayload = JSON.parse(byQuery.result.output[0].text);
  assert.deepEqual(queryPayload.loaded, []);
  assert.deepEqual(queryPayload.tools, []);
  assert.ok(queryPayload.not_loaded.some((row) => (
    row.name === "rg_get_grid" && row.reason === "Not available in this turn. Ask again in your next message."
  )));
  assert.equal(byQuery.result.control, undefined);

  // rememberLoaded did not record rg_get_grid.
  const savedConv = ctx.win[CHAT_BRIDGE_STATE_KEY].conversations.get(conversation.id);
  assert.equal(savedConv.loaded.has("rg_get_grid"), false);
  assert.equal(savedConv.loaded.has("bt_search"), true);

  // preload also refuses to load a tool that was not offered in this turn's configure.
  await conversation.submit({ type: "input", content: SORT_REQUEST }, {});
  assert.equal(savedConv.loaded.has("rg_sort"), false);
  assert.equal(conversation.config.modelTools?.add?.includes("rg_sort") ?? false, false);
});

test("preload filters carried-over loaded tools when access changes to read-only or an extension is disabled", async () => {
  const ctx = setup();
  const { conversation, roamTools } = await attachAndBoot(ctx, { mode: "edit", content: SORT_REQUEST });
  assert.ok(toolNames(await conversation.agent({})).includes("rg_sort"));

  // Switch the same conversation to read-only and trigger a Better Tasks preload.
  await roamTurn(conversation, roamTools, { mode: "read", content: "Show my overdue tasks" });
  assert.equal(conversation.config.modelTools.add.includes("rg_sort"), false);
  assert.ok(conversation.config.modelTools.add.includes("bt_search"));

  // Back in edit mode, disable Roam Grid mid-chat and trigger another preload.
  ctx.settingValues[extensionEnabledSettingId("roam-grid")] = false;
  await ctx.bridge.refresh();
  await roamTurn(conversation, roamTools, { mode: "edit", content: "Give me an oblique strategy" });
  assert.equal(conversation.config.modelTools.add.some((name) => name.startsWith("rg_")), false);
  assert.ok(conversation.config.modelTools.add.includes("os_random_strategy"));
});
