import { LOG_PREFIX, MAX_RESULT_CHARS } from "./constants.js";
import {
  FIND_TOOL_DESCRIPTION,
  FIND_TOOL_NAME,
  FIND_TOOL_PARAMETERS,
  MAX_CHAT_DESCRIPTION_CHARS,
  MAX_PRELOAD,
  buildChatCatalog,
  deriveChatAccess,
  emptyChatCatalog,
  findExtensionTools,
  readNativeExtensions,
  renderIndexSection,
  suggestTools,
} from "./chat-catalog.js";
import { finalizeToolResult } from "./hub-tools.js";
import { truncateText } from "./registry.js";

/**
 * Bridge between Tool Hub and Roam's built-in chat (Cmd-J, Ask AI on a block).
 *
 * Roam's chat runs on `window.PiHarness`, whose registry holds extensions made of tools,
 * prompt sections and hooks. Roam installs one named `roam`. This module installs a second
 * one, `tool-hub`, and adds its tool names to the list Roam sets on each turn.
 *
 * Nothing here is a documented Roam API. Every step checks the shape it needs first and
 * the chat is left exactly as it was when a check fails. See docs/spec-cmdj-bridge.md.
 */

export const CHAT_BRIDGE_STATE_KEY = "__roamToolHubChatBridge";
export const CHAT_EXTENSION_NAME = "tool-hub";
export const CHAT_SECTION_KEY = "toolhub";

const RUNTIME_GLOBAL = "PiHarness";
const ROAM_EXTENSION_NAME = "roam";
const ROAM_CHAT_MARKER_TOOLS = ["get_page", "search"];
const NATIVE_TOOLS_TTL_MS = 15_000;
const NATIVE_TOOLS_TIMEOUT_MS = 1_500;
const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_LOADED_PER_CONVERSATION = 24;
const MAX_TRACKED_CONVERSATIONS = 200;
const MAX_TRACKED_REGISTRIES = 4;
const BLOCK_RUN_UID_RE = /user-authored Roam block with UID `([^`\s]{6,40})`/;
const READ_ONLY_MESSAGE = "This conversation has read-only access to the graph.";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" ? error : String(error);
}

function textResult(value, isError = false) {
  let text;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value ?? null);
    } catch {
      text = String(value);
    }
  }
  return { output: [{ type: "text", text }], details: null, isError };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Returns a reason string when the chat runtime does not look the way this bridge needs. */
export function checkRuntimeShape(runtime) {
  const durable = runtime?.durable;
  const needed = [
    [durable?.createRegistry, "durable.createRegistry"],
    [durable?.defineExtension, "durable.defineExtension"],
    [durable?.section, "durable.section"],
    [durable?.hook, "durable.hook"],
    [durable?.Harness?.open, "durable.Harness.open"],
    [durable?.MemoryStorage, "durable.MemoryStorage"],
    [runtime?.createModels, "createModels"],
  ];
  for (const [value, label] of needed) {
    if (typeof value !== "function") return `${label} is missing`;
  }
  if (typeof durable.ToolTask?.definition?.name !== "string") return "durable.ToolTask is missing";
  if (durable.BACKGROUND_CONTEXT === undefined || durable.BACKGROUND_CONTEXT === null) {
    return "durable.BACKGROUND_CONTEXT is missing";
  }
  return null;
}

function pageState(win) {
  let state = win[CHAT_BRIDGE_STATE_KEY];
  if (!state || typeof state !== "object") {
    state = {
      impl: null,
      registries: new Set(),
      installed: new WeakMap(),
      conversations: new Map(),
      patches: null,
      trap: null,
      status: { phase: "off" },
    };
    Object.defineProperty(win, CHAT_BRIDGE_STATE_KEY, {
      value: state,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  return state;
}

export function createChatBridge({
  windowRef = globalThis.window,
  extensionAPI,
  getRegistrySnapshot,
  getNativeTools = async () => [],
  runRegistryTool,
  callNativeTool,
  confirmWrite,
  isAutoLoadEnabled = () => true,
  isChatAutoApproved = () => false,
  setChatAutoApproved = async () => {},
  readBlockText = () => "",
  onStatus,
  maxResultChars = MAX_RESULT_CHARS,
  logger = console,
} = {}) {
  // Without a window (unit tests, a non-browser host) the bridge still builds and reports
  // a failure when asked to attach, so the extension loads either way.
  const hasWindow = Boolean(windowRef);
  if (!hasWindow) windowRef = {};
  const state = pageState(windowRef);

  const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let attached = false;
  let runtime = null;
  let catalog = emptyChatCatalog();
  let installedNames = new Set();
  let refreshing = null;
  let nativeCache = { at: 0, tools: [] };
  const warned = new Set();
  const stats = { turns: 0, preloads: 0, finds: 0, calls: 0, blocked: 0, errors: 0 };

  function warnOnce(key, error) {
    stats.errors += 1;
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn?.(`${LOG_PREFIX} Chat bridge: ${key}`, error);
  }

  function setStatus(patch) {
    state.status = {
      ...state.status,
      ...patch,
      tools: catalog.tools.length,
      extensions: catalog.extensions.length,
      registries: state.registries.size,
      stats: { ...stats },
      updatedAt: Date.now(),
    };
    try {
      onStatus?.(state.status);
    } catch {
      // A status observer must never break the chat.
    }
  }

  function fail(detail, error) {
    if (error) warnOnce(detail, error);
    setStatus({ phase: "failed", detail });
  }

  // ---- per-conversation memory -------------------------------------------------

  function conversationState(id) {
    if (id === undefined || id === null) return { access: undefined, loaded: new Set(), guidesSent: new Set() };
    let conv = state.conversations.get(id);
    if (conv) {
      state.conversations.delete(id);
    } else {
      conv = { access: undefined, loaded: new Set(), guidesSent: new Set(), probed: false };
    }
    state.conversations.set(id, conv);
    while (state.conversations.size > MAX_TRACKED_CONVERSATIONS) {
      state.conversations.delete(state.conversations.keys().next().value);
    }
    return conv;
  }

  function peekConversation(id) {
    return id === undefined || id === null ? undefined : state.conversations.get(id);
  }

  function rememberLoaded(conv, names) {
    for (const name of names) {
      conv.loaded.delete(name);
      conv.loaded.add(name);
    }
    while (conv.loaded.size > MAX_LOADED_PER_CONVERSATION) {
      conv.loaded.delete(conv.loaded.values().next().value);
    }
  }

  // ---- catalog -----------------------------------------------------------------

  async function readNativeTools(force) {
    const now = Date.now();
    if (!force && now - nativeCache.at < NATIVE_TOOLS_TTL_MS) return nativeCache.tools;
    try {
      const tools = await withTimeout(Promise.resolve(getNativeTools()), NATIVE_TOOLS_TIMEOUT_MS, "Reading native extension tools");
      nativeCache = { at: Date.now(), tools: Array.isArray(tools) ? tools : [] };
    } catch (error) {
      warnOnce("native extension tools could not be read", error);
      nativeCache = { at: Date.now(), tools: nativeCache.tools };
    }
    return nativeCache.tools;
  }

  function refresh({ force = false } = {}) {
    if (refreshing) return force ? refreshing.then(() => refresh({ force })) : refreshing;
    refreshing = (async () => {
      const snapshot = getRegistrySnapshot();
      const native = await readNativeTools(force);
      const next = buildChatCatalog({
        registryExtensions: snapshot?.extensions ?? [],
        nativeExtensions: readNativeExtensions(native),
        extensionAPI,
      });
      const changed = next.signature !== catalog.signature;
      if (changed) catalog = next;
      if (changed || force) {
        for (const registry of state.registries) installInto(registry);
        setStatus({});
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  // ---- what the chat's registry receives ----------------------------------------

  async function runFind(args, context) {
    stats.finds += 1;
    const conv = conversationState(context?.conversationId);
    const { payload, load } = findExtensionTools(args, {
      catalog,
      access: conv.access ?? "edit",
      guidesSent: conv.guidesSent,
    });
    const usable = load.filter((name) => installedNames.has(name));
    rememberLoaded(conv, usable);
    const result = textResult(payload, false);
    result.details = { found: payload.tools.length };
    if (usable.length > 0) result.control = { addTools: usable };
    return result;
  }

  async function runTool(chatName, args, context) {
    stats.calls += 1;
    const entry = catalog.byName.get(chatName);
    if (!entry) {
      return textResult({ error: `${chatName} is no longer available. Call ${FIND_TOOL_NAME} to see what is.` }, true);
    }
    if (!entry.readOnly && peekConversation(context?.conversationId)?.access === "read") {
      return textResult({ error: READ_ONLY_MESSAGE }, true);
    }
    const toolArgs = isPlainObject(args) ? args : {};
    let raw;
    try {
      if (entry.native) {
        const response = await callNativeTool(entry.id, toolArgs);
        const value = isPlainObject(response) && "result" in response ? response.result : response;
        raw = finalizeToolResult(entry.id, value, maxResultChars);
      } else {
        raw = await runRegistryTool(entry.id, toolArgs);
      }
    } catch (error) {
      raw = { tool: entry.id, code: "execution-error", error: errorMessage(error) };
    }
    const failed = isPlainObject(raw) && typeof raw.error === "string" && typeof raw.code === "string";
    if (failed) return textResult({ error: raw.error, code: raw.code }, true);
    const body = isPlainObject(raw) && "result" in raw && raw.truncated !== true ? raw.result : raw;
    return textResult(body, false);
  }

  async function beforeTool(call, task, context) {
    const name = call?.name;
    if (typeof name !== "string" || !installedNames.has(name)) return undefined;
    const entry = catalog.byName.get(name);
    if (!entry || entry.readOnly) return undefined;
    try {
      const conv = peekConversation(task?.conversationId ?? context?.conversationId);
      if (conv?.access === "read") {
        stats.blocked += 1;
        return { block: READ_ONLY_MESSAGE };
      }
      // A chat this session has not seen configured (for example one resumed after a
      // reload) always asks, whatever the extension's setting says.
      if (conv?.access && isChatAutoApproved(entry.extensionKey)) return undefined;
      if (typeof confirmWrite !== "function") {
        stats.blocked += 1;
        return { block: "Tool Hub has no way to ask the person to confirm this change, so it was not made." };
      }
      const decision = await confirmWrite({
        toolName: entry.chatName,
        toolId: entry.id,
        extensionKey: entry.extensionKey,
        extensionName: entry.extensionName,
        description: entry.shortDescription,
        args: isPlainObject(call.arguments) ? call.arguments : {},
        signal: context?.abortSignal ?? task?.signal,
      });
      if (decision === "always") {
        await setChatAutoApproved(entry.extensionKey, true);
        return undefined;
      }
      if (decision === "once") return undefined;
      stats.blocked += 1;
      return { block: "The user rejected this change." };
    } catch (error) {
      warnOnce("confirming a change failed", error);
      stats.blocked += 1;
      return { block: "Tool Hub could not confirm this change with the person, so it was not made." };
    }
  }

  function renderSection(sectionContext) {
    try {
      const conv = peekConversation(sectionContext?.conversationId);
      return renderIndexSection(catalog, {
        access: conv?.access ?? "edit",
        loadedNames: conv ? [...conv.loaded] : [],
      });
    } catch (error) {
      warnOnce("rendering the prompt section failed", error);
      return undefined;
    }
  }

  function buildExtension(roamNames) {
    if (!runtime || catalog.tools.length === 0 || roamNames.has(FIND_TOOL_NAME)) return null;
    const durable = runtime.durable;
    const names = new Set([FIND_TOOL_NAME]);
    const tools = [{
      name: FIND_TOOL_NAME,
      label: "Find extension tools",
      description: FIND_TOOL_DESCRIPTION,
      parameters: FIND_TOOL_PARAMETERS,
      executionMode: "parallel",
      replay: "safe",
      execute: (args, context) => runFind(args, context),
    }];
    for (const entry of catalog.tools) {
      // Never shadow one of Roam's own tools: a later extension wins on a name clash.
      if (roamNames.has(entry.chatName) || names.has(entry.chatName)) continue;
      names.add(entry.chatName);
      tools.push({
        name: entry.chatName,
        label: `${entry.extensionName}: ${entry.name}`,
        description: truncateText(`[${entry.extensionName}] ${entry.description || entry.name}`, MAX_CHAT_DESCRIPTION_CHARS),
        parameters: entry.parameters,
        deferred: true,
        executionMode: entry.readOnly ? "parallel" : "sequential",
        replay: entry.readOnly ? "safe" : "unsafe",
        outputLimits: { maxBytes: 240_000, maxLines: 60_000 },
        execute: (args, context) => runTool(entry.chatName, args, context),
      });
    }
    return {
      names,
      extension: durable.defineExtension({
        name: CHAT_EXTENSION_NAME,
        tools,
        sections: [durable.section(CHAT_SECTION_KEY, renderSection)],
        hooks: [durable.hook(durable.ToolTask, { beforeTool })],
      }),
    };
  }

  function installInto(registry) {
    if (!attached || !runtime) return;
    try {
      const roam = registry.snapshot()?.extension?.(ROAM_EXTENSION_NAME);
      if (!roam) return;
      const roamNames = new Set((roam.tools ?? []).map((tool) => tool?.name).filter(Boolean));
      const key = `${instanceId}\u0000${catalog.signature}\u0000${[...roamNames].sort().join(",")}`;
      if (state.installed.get(registry) !== key) {
        const built = buildExtension(roamNames);
        if (!built) {
          registry.uninstall({ name: CHAT_EXTENSION_NAME });
          state.installed.delete(registry);
          installedNames = new Set();
        } else {
          registry.install(built.extension);
          state.installed.set(registry, key);
          installedNames = built.names;
        }
      }
      if (state.patches?.conversation && state.installed.has(registry)) {
        setStatus({ phase: "attached", detail: "" });
      }
    } catch (error) {
      fail("installing into the chat registry failed", error);
    }
  }

  function adoptRegistry(registry) {
    state.registries.delete(registry);
    state.registries.add(registry);
    while (state.registries.size > MAX_TRACKED_REGISTRIES) {
      state.registries.delete(state.registries.values().next().value);
    }
    installInto(registry);
  }

  // ---- what happens on each chat turn --------------------------------------------

  async function augmentConfig(conversation, config, context) {
    if (!isPlainObject(config) || !Array.isArray(config.tools)) return config;
    const roamNames = config.tools.map((tool) => tool?.name).filter((name) => typeof name === "string");
    if (!ROAM_CHAT_MARKER_TOOLS.some((name) => roamNames.includes(name))) return config;

    stats.turns += 1;
    const conv = conversationState(conversation.id);
    conv.access = deriveChatAccess(roamNames);
    await refresh();

    if (!conv.probed) {
      conv.probed = true;
      // Reading the agent makes the harness read its registry, which is how a registry
      // that existed before this bridge loaded gets noticed.
      try {
        await conversation.agent(context);
        await Promise.resolve();
      } catch (error) {
        warnOnce("probing the conversation failed", error);
      }
    }

    const taken = new Set(roamNames);
    const allowed = catalog.tools.filter((tool) => (
      installedNames.has(tool.chatName) && !taken.has(tool.chatName) && (tool.readOnly || conv.access !== "read")
    ));
    if (allowed.length === 0 || !installedNames.has(FIND_TOOL_NAME)) return config;

    const next = {
      ...config,
      tools: [...config.tools, { name: FIND_TOOL_NAME }, ...allowed.map((tool) => ({ name: tool.chatName }))],
    };
    if (config.modelTools === undefined) {
      const allowedNames = new Set(allowed.map((tool) => tool.chatName));
      const loaded = [...conv.loaded].filter((name) => allowedNames.has(name));
      if (loaded.length > 0) next.modelTools = { add: loaded.map((name) => ({ name })) };
    }
    return next;
  }

  async function verifyTurn(conversation, context) {
    if (state.status.verified === true) return;
    try {
      const agent = await conversation.agent(context);
      const names = (agent?.tools ?? []).map((tool) => tool?.name);
      setStatus({ verified: names.includes(FIND_TOOL_NAME) });
    } catch {
      // Verification is a courtesy for the status line.
    }
  }

  async function preload(conversation, input, context, originalConfigure) {
    if (!isAutoLoadEnabled() || input?.type !== "input" || catalog.tools.length === 0) return;
    const conv = peekConversation(conversation.id);
    if (!conv?.access) return;
    let text = extractText(input.content);
    const blockRun = BLOCK_RUN_UID_RE.exec(text);
    // Ask AI on a block wraps the request in fixed wording; only the block's own text
    // says what the person wants.
    if (blockRun) text = String(readBlockText(blockRun[1]) ?? "");
    if (!text.trim()) return;
    const picks = suggestTools(catalog, text, { access: conv.access, exclude: [...conv.loaded], max: MAX_PRELOAD })
      .map((tool) => tool.chatName)
      .filter((name) => installedNames.has(name));
    if (picks.length === 0) return;
    rememberLoaded(conv, picks);
    await originalConfigure.call(
      conversation,
      { modelTools: { add: [...conv.loaded].map((name) => ({ name })) } },
      context,
    );
    stats.preloads += 1;
  }

  const impl = {
    onRuntime,
    onRegistry: adoptRegistry,
    async configure(conversation, config, context, original) {
      let next = config;
      try {
        next = await augmentConfig(conversation, config, context);
      } catch (error) {
        warnOnce("preparing a turn failed", error);
        next = config;
      }
      if (next === config) return original.call(conversation, config, context);
      let result;
      try {
        result = await original.call(conversation, next, context);
      } catch (error) {
        warnOnce("Roam rejected the extended tool list", error);
        return original.call(conversation, config, context);
      }
      void verifyTurn(conversation, context);
      return result;
    },
    async submit(conversation, input, context, original, originalConfigure) {
      try {
        await preload(conversation, input, context, originalConfigure);
      } catch (error) {
        warnOnce("loading tools ahead of a turn failed", error);
      }
      return original.call(conversation, input, context);
    },
  };

  // ---- patching the runtime ------------------------------------------------------

  function patchRegistryPrototype(proto) {
    const originalInstall = proto.install;
    const originalSnapshot = proto.snapshot;
    if (typeof originalInstall !== "function" || typeof originalSnapshot !== "function" || typeof proto.uninstall !== "function") {
      throw new Error("the chat registry no longer has install, snapshot and uninstall");
    }
    const install = function install(extension) {
      const result = originalInstall.call(this, extension);
      try {
        if (extension?.name === ROAM_EXTENSION_NAME) state.impl?.onRegistry(this);
      } catch (error) {
        logger.warn?.(`${LOG_PREFIX} Chat bridge: registry install hook failed`, error);
      }
      return result;
    };
    const snapshot = function snapshot() {
      const result = originalSnapshot.call(this);
      try {
        if (state.impl && !state.registries.has(this) && result?.extension?.(ROAM_EXTENSION_NAME)) {
          state.registries.add(this);
          const registry = this;
          queueMicrotask(() => state.impl?.onRegistry(registry));
        }
      } catch (error) {
        logger.warn?.(`${LOG_PREFIX} Chat bridge: registry snapshot hook failed`, error);
      }
      return result;
    };
    proto.install = install;
    proto.snapshot = snapshot;
    return { proto, originalInstall, originalSnapshot, install, snapshot };
  }

  function patchConversationPrototype(proto) {
    const originalConfigure = proto.configure;
    const originalSubmit = proto.submit;
    if (typeof originalConfigure !== "function" || typeof originalSubmit !== "function" || typeof proto.agent !== "function") {
      throw new Error("a chat conversation no longer has configure, submit and agent");
    }
    const configure = function configure(config, context) {
      const active = state.impl;
      if (!active) return originalConfigure.call(this, config, context);
      return active.configure(this, config, context, originalConfigure);
    };
    const submit = function submit(input, context) {
      const active = state.impl;
      if (!active) return originalSubmit.call(this, input, context);
      return active.submit(this, input, context, originalSubmit, originalConfigure);
    };
    proto.configure = configure;
    proto.submit = submit;
    return { proto, originalConfigure, originalSubmit, configure, submit };
  }

  async function discoverConversationPrototype(piRuntime) {
    const durable = piRuntime.durable;
    const context = durable.BACKGROUND_CONTEXT;
    let harness;
    try {
      harness = await durable.Harness.open(
        new durable.MemoryStorage(),
        { models: piRuntime.createModels(), registry: durable.createRegistry(), settings: {} },
        context,
      );
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
      return Object.getPrototypeOf(conversation);
    } finally {
      if (harness && typeof harness.close === "function") {
        try {
          await harness.close(context);
        } catch {
          // The throwaway harness holds nothing worth keeping.
        }
      }
    }
  }

  async function onRuntime(piRuntime) {
    if (!attached) return;
    const problem = checkRuntimeShape(piRuntime);
    if (problem) {
      fail(`Roam's chat runtime changed: ${problem}`);
      return;
    }
    runtime = piRuntime;
    try {
      if (!state.patches) state.patches = { registry: null, conversation: null };
      if (!state.patches.registry) {
        state.patches.registry = patchRegistryPrototype(Object.getPrototypeOf(piRuntime.durable.createRegistry()));
      }
      await refresh({ force: true });
      if (!attached) return;
      if (!state.patches.conversation) {
        setStatus({ phase: "starting", detail: "" });
        const proto = await withTimeout(
          discoverConversationPrototype(piRuntime),
          DISCOVERY_TIMEOUT_MS,
          "Finding the chat conversation type",
        );
        if (!attached) return;
        if (!state.patches.conversation) state.patches.conversation = patchConversationPrototype(proto);
      }
      for (const registry of state.registries) installInto(registry);
      if (state.status.phase !== "attached" && state.status.phase !== "failed") {
        setStatus({ phase: "ready", detail: "" });
      }
    } catch (error) {
      fail(`Roam's chat runtime changed: ${errorMessage(error)}`, error);
    }
  }

  function installRuntimeTrap() {
    if (state.trap) return true;
    const existing = Object.getOwnPropertyDescriptor(windowRef, RUNTIME_GLOBAL);
    if (existing && !existing.configurable) return false;
    let held;
    const trap = {
      get() {
        return held;
      },
      set(value) {
        held = value;
        state.trap = null;
        Object.defineProperty(windowRef, RUNTIME_GLOBAL, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
        if (value) void state.impl?.onRuntime(value);
      },
    };
    Object.defineProperty(windowRef, RUNTIME_GLOBAL, {
      configurable: true,
      enumerable: true,
      get: trap.get,
      set: trap.set,
    });
    state.trap = trap;
    return true;
  }

  function removeRuntimeTrap() {
    const trap = state.trap;
    if (!trap) return;
    const existing = Object.getOwnPropertyDescriptor(windowRef, RUNTIME_GLOBAL);
    if (existing?.set === trap.set) delete windowRef[RUNTIME_GLOBAL];
    state.trap = null;
  }

  function restorePatches() {
    const patches = state.patches;
    if (!patches) return;
    let clean = true;
    const registry = patches.registry;
    if (registry) {
      if (registry.proto.install === registry.install && registry.proto.snapshot === registry.snapshot) {
        registry.proto.install = registry.originalInstall;
        registry.proto.snapshot = registry.originalSnapshot;
        patches.registry = null;
      } else {
        clean = false;
      }
    }
    const conversation = patches.conversation;
    if (conversation) {
      if (conversation.proto.configure === conversation.configure && conversation.proto.submit === conversation.submit) {
        conversation.proto.configure = conversation.originalConfigure;
        conversation.proto.submit = conversation.originalSubmit;
        patches.conversation = null;
      } else {
        clean = false;
      }
    }
    // Wrappers someone else wrapped again stay in place and pass straight through.
    if (clean) state.patches = null;
  }

  return {
    attach() {
      if (attached) return;
      if (!hasWindow) {
        fail("there is no browser window to attach to");
        return;
      }
      attached = true;
      state.impl = impl;
      const existing = windowRef[RUNTIME_GLOBAL];
      if (existing) {
        setStatus({ phase: "starting", detail: "", verified: false });
        void onRuntime(existing);
      } else if (installRuntimeTrap()) {
        setStatus({ phase: "waiting", detail: "", verified: false });
      } else {
        fail("Roam's chat runtime cannot be observed in this window");
      }
    },

    detach() {
      if (!attached) return;
      attached = false;
      if (state.impl === impl) state.impl = null;
      for (const registry of state.registries) {
        try {
          registry.uninstall({ name: CHAT_EXTENSION_NAME });
        } catch {
          // The registry may belong to a harness that has closed.
        }
        state.installed.delete(registry);
      }
      installedNames = new Set();
      removeRuntimeTrap();
      restorePatches();
      runtime = null;
      setStatus({ phase: "off", detail: "", verified: false });
    },

    /** Re-read extensions and settings and update the chat. */
    refresh: (options) => (attached ? refresh({ force: true, ...options }) : Promise.resolve()),

    status: () => state.status,

    get attached() {
      return attached;
    },
  };
}
