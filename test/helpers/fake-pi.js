import { readFileSync } from "node:fs";

const TASK_TOOL = "pi.tool";

class Snapshot {
  constructor(extensions) {
    this._extensions = extensions;
  }

  installed() {
    return this._extensions;
  }

  extension(name) {
    return this._extensions.find((ext) => ext.name === name);
  }

  tools() {
    return this._extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ extension, tool })));
  }

  sections() {
    return this._extensions.flatMap((extension) => (extension.sections ?? []).map((section) => ({ extension, section })));
  }

  task() {
    return {};
  }
}

class Registry {
  constructor() {
    this._extensions = [];
    this._subscribers = new Set();
  }

  snapshot() {
    return new Snapshot([...this._extensions]);
  }

  subscribe(fn) {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }

  install(extension) {
    const names = new Set();
    for (const tool of extension.tools ?? []) {
      if (names.has(tool.name)) throw new Error(`Duplicate tool ${tool.name} in ${extension.name}`);
      names.add(tool.name);
    }
    const index = this._extensions.findIndex((existing) => existing.name === extension.name);
    if (index >= 0) this._extensions[index] = extension;
    else this._extensions.push(extension);
    for (const fn of [...this._subscribers]) fn(this.snapshot());
  }

  uninstall({ name }) {
    this._extensions = this._extensions.filter((extension) => extension.name !== name);
    for (const fn of [...this._subscribers]) fn(this.snapshot());
  }
}

function namesOf(list) {
  return (list ?? []).map((entry) => (typeof entry === "string" ? entry : entry?.name));
}

export function createFakePi({ withHook = true } = {}) {
  class Conversation {
    constructor(harness, id) {
      this.harness = harness;
      this.id = id;
      this.config = {};
    }

    configure(cfg, context) {
      void context;
      for (const key of ["model", "thinkingLevel", "instructions"]) {
        if (cfg[key] === undefined) continue;
        if (cfg[key] === null) delete this.config[key];
        else this.config[key] = cfg[key];
      }
      if (cfg.tools !== undefined) {
        if (cfg.tools === null) delete this.config.tools;
        else if (Array.isArray(cfg.tools)) this.config.tools = namesOf(cfg.tools);
        else this.config.tools = { remove: namesOf(cfg.tools.remove) };
      }
      if (cfg.modelTools !== undefined) {
        if (cfg.modelTools === null) delete this.config.modelTools;
        else if (Array.isArray(cfg.modelTools)) this.config.modelTools = namesOf(cfg.modelTools);
        else {
          this.config.modelTools = {
            add: namesOf(cfg.modelTools.add),
            remove: namesOf(cfg.modelTools.remove),
          };
        }
      }
      return Promise.resolve({});
    }

    async agent(context) {
      void context;
      const snapshot = this.harness.registry.snapshot();
      const extensions = snapshot.installed();
      const byName = new Map();
      for (const extension of extensions) for (const tool of extension.tools ?? []) byName.set(tool.name, tool);
      const cfg = this.config;
      let all;
      if (Array.isArray(cfg.tools)) {
        all = [...new Set(cfg.tools)].filter((name) => byName.has(name)).map((name) => byName.get(name));
      } else {
        all = [...byName.values()];
      }
      const modelTools = cfg.modelTools;
      let model;
      if (Array.isArray(modelTools)) {
        const wanted = new Set(modelTools);
        model = all.filter((tool) => wanted.has(tool.name));
      } else {
        const removed = new Set(modelTools?.remove ?? []);
        const added = new Set(modelTools?.add ?? []);
        model = all.filter((tool) => (
          (!tool.deferred && !removed.has(tool.name)) || (tool.deferred && added.has(tool.name) && !removed.has(tool.name))
        ));
      }
      const modelNames = new Set(model.map((tool) => tool.name));
      return {
        tools: model,
        callable: all,
        deferred: all.filter((tool) => tool.deferred && !modelNames.has(tool.name)),
        sections: snapshot.sections(),
        extensions,
      };
    }

    async submit(input, context) {
      void context;
      this.harness.submitted.push({ conversationId: this.id, input });
      return { id: `turn-${this.harness.submitted.length}`, wait: async () => ({}) };
    }
  }

  class Harness {
    constructor(registry) {
      this.registry = registry;
      this.submitted = [];
      this.closed = false;
      this._conversations = new Map();
      this._nextId = 1;
    }

    async createConversation(opts, context) {
      void opts;
      void context;
      const conversation = new Conversation(this, this._nextId);
      this._nextId += 1;
      this._conversations.set(conversation.id, conversation);
      return conversation;
    }

    async conversation(id, context) {
      void context;
      return this._conversations.get(id);
    }

    async close(context) {
      void context;
      this.closed = true;
    }
  }

  const durable = {
    createRegistry: () => new Registry(),
    defineExtension: (extension) => extension,
    section: (key, render, opts) => (opts?.tag === undefined ? { key, render } : { key, render, tag: opts.tag }),
    ToolTask: { definition: { name: TASK_TOOL } },
    Harness: {
      open: async (storage, opts, context) => {
        void storage;
        void context;
        return new Harness(opts.registry);
      },
    },
    MemoryStorage: class {},
    BACKGROUND_CONTEXT: {},
  };
  if (withHook) durable.hook = (task, handlers) => ({ task: task.definition.name, handlers });

  return {
    pi: { durable, createModels: () => ({}) },
    Registry,
    Conversation,
    Harness,
  };
}

const ROAM_TOOL_NAMES = ["get_page", "search", "create_block", "update_block"];

function fakeRoamTool(name) {
  return {
    name,
    description: `Roam ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async (args) => ({ roam: name, args }),
  };
}

export function roamToolsForMode(roamTools, mode) {
  if (mode === "read") return roamTools.filter((tool) => !["create_block", "update_block"].includes(tool.name));
  if (mode === "append") return roamTools.filter((tool) => tool.name !== "update_block");
  return roamTools;
}

/** Does what Roam does when its assistant starts: one `roam` extension, then a harness. */
export async function bootRoamChat(pi) {
  const registry = pi.durable.createRegistry();
  const roamTools = ROAM_TOOL_NAMES.map(fakeRoamTool);
  registry.install({
    name: "roam",
    tools: roamTools,
    sections: [pi.durable.section("roam", () => "ROAM", { tag: false })],
  });
  const harness = await pi.durable.Harness.open(new pi.durable.MemoryStorage(), { registry }, pi.durable.BACKGROUND_CONTEXT);
  return { registry, harness, roamTools };
}

/** One Roam turn: configure with the mode's tools, then submit the message. */
export async function roamTurn(conversation, roamTools, { mode = "edit", content } = {}) {
  await conversation.configure({
    model: { id: "fake" },
    thinkingLevel: "off",
    tools: roamToolsForMode(roamTools, mode),
  }, {});
  if (content !== undefined) {
    await conversation.submit({ type: "input", content }, {});
  }
}

/** Mimics one model tool call against the conversation's current tool list. */
export async function runToolCall(conversation, name, args, { signal } = {}) {
  const agent = await conversation.agent({});
  const tool = agent.callable.find((candidate) => candidate.name === name);
  if (!tool) return { missing: true };
  const task = { conversationId: conversation.id };
  for (const extension of agent.extensions) {
    for (const hook of extension.hooks ?? []) {
      if (hook.task !== TASK_TOOL) continue;
      const verdict = await hook.handlers.beforeTool?.({ name, arguments: args }, task, { abortSignal: signal });
      if (verdict?.block) return { blocked: verdict.block };
    }
  }
  const result = await tool.execute(args, task, { abortSignal: signal });
  const added = result?.control?.addTools;
  if (Array.isArray(added) && added.length > 0) {
    const stored = conversation.config;
    if (Array.isArray(stored.tools)) {
      for (const added_name of added) if (!stored.tools.includes(added_name)) stored.tools.push(added_name);
    }
    const modelTools = Array.isArray(stored.modelTools) ? null : (stored.modelTools ?? { add: [], remove: [] });
    if (modelTools) {
      for (const added_name of added) if (!modelTools.add.includes(added_name)) modelTools.add.push(added_name);
      stored.modelTools = modelTools;
    }
  }
  return { result };
}

export function loadRegistryFixture() {
  return JSON.parse(readFileSync(new URL("../fixtures/registry-sample.json", import.meta.url), "utf8"));
}

/** Turns the fixture dump into a `window.RoamExtensionTools`-shaped object. */
export function buildRegistryFromFixture(fixture = loadRegistryFixture(), { calls = [], extra = {} } = {}) {
  const registry = {};
  for (const [key, ext] of Object.entries(fixture)) {
    registry[key] = {
      name: ext.name,
      version: ext.version,
      tools: ext.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly,
        isMutating: tool.isMutating,
        parameters: {
          type: "object",
          properties: Object.fromEntries((tool.params ?? []).map((param) => [param, { type: "string" }])),
        },
        execute: async (args) => {
          calls.push({ extension: key, tool: tool.name, args });
          return { ok: true, name: tool.name, args };
        },
      })),
    };
  }
  return Object.assign(registry, extra);
}
