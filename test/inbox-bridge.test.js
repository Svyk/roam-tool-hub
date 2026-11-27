import assert from "node:assert/strict";
import test from "node:test";

import { INBOX_PAGE_TITLE, INBOX_RESULT_PREFIX } from "../src/constants.js";
import { buildGuidelinesIndexModel } from "../src/guidelines-index.js";
import { createHubTools } from "../src/hub-tools.js";
import { createInboxBridge, parseInboxCall, serializeInboxResult } from "../src/inbox-bridge.js";
import { extensionWriteSettingId } from "../src/settings.js";

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

function makeFakeRoamWithWatch() {
  let uidSeq = 1;
  const pages = new Map();
  const blocks = new Map();
  const watches = [];

  function serializeBlock(b) {
    const out = {
      ":block/uid": b.uid,
      ":block/string": b.string,
      ...(b.creatorUid ? { ":create/user": { ":user/uid": b.creatorUid } } : {}),
    };
    if (b.children.length > 0) {
      out[":block/children"] = b.children.map((c, idx) => ({
        ...serializeBlock(c),
        ":block/order": idx,
      }));
    }
    return out;
  }

  function notifyWatch(pageUid) {
    const page = blocks.get(pageUid);
    if (!page) return;
    const entityStr = `[:block/uid "${pageUid}"]`;
    for (const w of [...watches]) {
      if (w.entity === entityStr) {
        w.cb(null, serializeBlock(page));
      }
    }
  }

  const roamAlphaAPI = {
    graph: { name: "Readwisenotes" },
    util: { generateUID: () => `u-${uidSeq++}` },
    data: {
      pull: (_pattern, entity) => {
        if (Array.isArray(entity) && entity[0] === ":node/title") {
          const page = pages.get(entity[1]);
          return page ? { ...serializeBlock(page), ":node/title": page.title } : null;
        }
        if (Array.isArray(entity) && entity[0] === ":block/uid") {
          const blk = blocks.get(entity[1]);
          return blk ? serializeBlock(blk) : null;
        }
        return null;
      },
      addPullWatch: async (pattern, entity, cb) => {
        watches.push({ pattern, entity, cb });
        return null;
      },
      removePullWatch: async (pattern, entity, cb) => {
        const idx = watches.findIndex((w) => w.pattern === pattern && w.entity === entity && w.cb === cb);
        if (idx >= 0) watches.splice(idx, 1);
        return null;
      },
      page: {
        create: async ({ page }) => {
          const node = { uid: page.uid, title: page.title, string: "", children: [] };
          pages.set(page.title, node);
          blocks.set(page.uid, node);
        },
      },
      block: {
        create: async ({ location, block, creatorUid }) => {
          const parent = blocks.get(location["parent-uid"]);
          assert.ok(parent, `Missing parent ${location["parent-uid"]}`);
          const node = {
            uid: block.uid || `u-${uidSeq++}`,
            string: block.string,
            parentUid: parent.uid,
            creatorUid: creatorUid || null,
            children: [],
          };
          if (location.order === "last" || location.order >= parent.children.length) {
            parent.children.push(node);
          } else {
            parent.children.splice(location.order, 0, node);
          }
          blocks.set(node.uid, node);
          if (pages.has(parent.title)) notifyWatch(parent.uid);
        },
        delete: async ({ block }) => {
          const node = blocks.get(block.uid);
          if (!node) return;
          const parent = blocks.get(node.parentUid);
          if (parent) parent.children = parent.children.filter((c) => c.uid !== block.uid);
          blocks.delete(block.uid);
        },
      },
    },
  };

  return { roamAlphaAPI, pages, blocks, watches };
}

test("parseInboxCall parses both nested args and flat args, handles backticks, and rejects malformed JSON", () => {
  assert.deepEqual(parseInboxCall("normal note"), { matched: false });

  const nested = parseInboxCall('rth-call {"action":"find_tools","args":{"extension":"grid"}}');
  assert.deepEqual(nested, { matched: true, action: "find_tools", args: { extension: "grid" } });

  const flat = parseInboxCall('`rth-call {"action":"find_tools","extension":"grid","query":"cell"}`');
  assert.deepEqual(flat, { matched: true, action: "find_tools", args: { extension: "grid", query: "cell" } });

  const implied = parseInboxCall('rth-call {"tool":"roam-grid/rg_list_grids","args":{}}');
  assert.deepEqual(implied, { matched: true, action: "run_tool", args: { tool: "roam-grid/rg_list_grids", args: {} } });

  const badJson = parseInboxCall("rth-call {broken}");
  assert.equal(badJson.matched, true);
  assert.match(badJson.error, /Invalid JSON/);

  const badAction = parseInboxCall('rth-call {"action":"drop_database"}');
  assert.equal(badAction.matched, true);
  assert.match(badAction.error, /Invalid action/);
});

test("inbox bridge executes new requests via pull watch, enforces write switches, attributes user-uid, skips pre-existing blocks, and prunes old entries", async () => {
  const api = makeFakeExtensionAPI();
  const graph = makeFakeRoamWithWatch();
  const seenContexts = [];
  const registry = {
    "roam-grid": {
      name: "Roam Grid",
      tools: [
        {
          name: "rg_list",
          readOnly: true,
          description: "List grids.",
          execute: (_args, ctx) => {
            seenContexts.push(ctx);
            return { grids: ["g1"] };
          },
        },
        {
          name: "rg_write",
          description: "Write grid.",
          execute: (args, ctx) => {
            seenContexts.push(ctx);
            return { ok: true, uid: args.uid };
          },
          parameters: { type: "object", required: ["uid"], properties: { uid: { type: "string" } } },
        },
      ],
    },
  };

  // Seed pre-existing request block before bridge starts -> must NEVER replay!
  await graph.roamAlphaAPI.data.page.create({ page: { title: INBOX_PAGE_TITLE, uid: "inbox-pg" } });
  await graph.roamAlphaAPI.data.block.create({
    location: { "parent-uid": "inbox-pg", order: "last" },
    block: { uid: "old-req", string: 'rth-call {"action":"list_extensions"}' },
  });

  const tools = createHubTools({ extensionAPI: api, getRegistry: () => registry });
  const bridge = createInboxBridge({
    roamAlphaAPI: graph.roamAlphaAPI,
    tools,
    maxHistory: 2,
  });

  const started = await bridge.start();
  assert.equal(started.active, true);
  assert.equal(started.pageUid, "inbox-pg");
  assert.equal(graph.watches.length, 1);
  // Pre-existing block untouched
  assert.equal(graph.blocks.get("old-req").children.length, 0);

  // 1) New read request from Cmd-J AI user
  await graph.roamAlphaAPI.data.block.create({
    location: { "parent-uid": "inbox-pg", order: "last" },
    block: { uid: "req-1", string: 'rth-call {"action":"run_read_tool","tool":"roam-grid/rg_list"}' },
    creatorUid: "ai-user-123",
  });
  await new Promise((r) => setTimeout(r, 20));

  const res1 = graph.blocks.get("req-1").children[0]?.string || "";
  assert.ok(res1.startsWith(`${INBOX_RESULT_PREFIX} `));
  const parsed1 = JSON.parse(res1.slice(INBOX_RESULT_PREFIX.length + 1));
  assert.deepEqual(parsed1, { tool: "roam-grid/rg_list", result: { grids: ["g1"] } });
  assert.equal(seenContexts[0].tokenUserUid, "ai-user-123");

  // 2) Write request refused while write switch is OFF
  await graph.roamAlphaAPI.data.block.create({
    location: { "parent-uid": "inbox-pg", order: "last" },
    block: { uid: "req-2", string: 'rth-call {"action":"run_tool","tool":"roam-grid/rg_write","args":{"uid":"x1"}}' },
    creatorUid: "ai-user-123",
  });
  await new Promise((r) => setTimeout(r, 20));

  const res2 = JSON.parse(graph.blocks.get("req-2").children[0].string.slice(INBOX_RESULT_PREFIX.length + 1));
  assert.equal(res2.code, "write-disabled");

  // 3) Enable write switch -> write succeeds and prunes oldest completed entry (maxHistory: 2)
  await api.settings.set(extensionWriteSettingId("roam-grid"), true);
  await graph.roamAlphaAPI.data.block.create({
    location: { "parent-uid": "inbox-pg", order: "last" },
    block: { uid: "req-3", string: 'rth-call {"action":"run_tool","tool":"roam-grid/rg_write","args":{"uid":"x2"}}' },
    creatorUid: "ai-user-123",
  });
  await new Promise((r) => setTimeout(r, 20));

  const res3 = JSON.parse(graph.blocks.get("req-3").children[0].string.slice(INBOX_RESULT_PREFIX.length + 1));
  assert.deepEqual(res3, { tool: "roam-grid/rg_write", result: { ok: true, uid: "x2" } });
  // req-1 pruned because maxHistory=2 keeps req-2 and req-3 (old-req had no result child so kept untouched)
  assert.equal(graph.blocks.has("req-1"), false);
  assert.equal(graph.blocks.has("req-2"), true);
  assert.equal(graph.blocks.has("req-3"), true);

  // Stop removes pull watch cleanly
  await bridge.dispose();
  assert.equal(graph.watches.length, 0);
});

test("serializeInboxResult caps huge payloads and guidelines model includes inbox instructions when active", () => {
  const capped = serializeInboxResult({ big: "X".repeat(5000) }, 500);
  assert.ok(capped.startsWith(`${INBOX_RESULT_PREFIX} `));
  const obj = JSON.parse(capped.slice(INBOX_RESULT_PREFIX.length + 1));
  assert.equal(obj.truncated, true);

  const model = buildGuidelinesIndexModel({
    extensions: [{ key: "roam-grid", name: "Roam Grid", toolCount: 1, readCount: 1, writeCount: 0, summary: "Tables." }],
    inboxPageUid: "inbox-pg-99",
  });
  assert.equal(model.children.length, 2);
  assert.match(model.children[0], /roam\/tool-hub\/inbox.*inbox-pg-99.*rth-call/);
});
