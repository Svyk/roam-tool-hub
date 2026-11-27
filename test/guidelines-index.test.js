import assert from "node:assert/strict";
import test from "node:test";

import { GUIDELINES_PAGE_TITLE, SETTING_IDS } from "../src/constants.js";
import {
  buildGuidelinesIndexModel,
  GUIDELINES_HEADING,
  removeGuidelinesIndex,
  syncGuidelinesIndex,
} from "../src/guidelines-index.js";
import { extensionEnabledSettingId, extensionWriteSettingId } from "../src/settings.js";

function makeFakeExtensionAPI(initial = {}) {
  const store = new Map(Object.entries(initial));
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

function makeFakeRoamGraph({ initialGuidelinesBlocks = [] } = {}) {
  let uidSeq = 1;
  const pages = new Map();
  const blocks = new Map();
  const writes = [];

  if (initialGuidelinesBlocks !== null) {
    const pageUid = "page-gl-1";
    const page = { uid: pageUid, title: GUIDELINES_PAGE_TITLE, children: [] };
    pages.set(GUIDELINES_PAGE_TITLE, page);
    blocks.set(pageUid, page);
    for (const entry of initialGuidelinesBlocks) {
      const b = { uid: entry.uid, string: entry.string, parentUid: pageUid, children: [] };
      page.children.push(b);
      blocks.set(b.uid, b);
    }
  }

  function serializeBlock(b) {
    const out = {
      ":block/uid": b.uid,
      ":block/string": b.string,
    };
    if (b.children?.length) {
      out[":block/children"] = b.children.map((child, idx) => ({
        ...serializeBlock(child),
        ":block/order": idx,
      }));
    }
    return out;
  }

  const roamAlphaAPI = {
    graph: { name: "Readwisenotes" },
    util: {
      generateUID: () => `uid-${uidSeq++}`,
    },
    data: {
      pull: (_pattern, entity) => {
        if (Array.isArray(entity) && entity[0] === ":node/title") {
          const page = pages.get(entity[1]);
          if (!page) return null;
          return {
            ":block/uid": page.uid,
            ":node/title": page.title,
            ":block/children": page.children.map((child, idx) => ({
              ...serializeBlock(child),
              ":block/order": idx,
            })),
          };
        }
        return null;
      },
      page: {
        create: async ({ page }) => {
          writes.push(["page.create", page.title, page.uid]);
          const node = { uid: page.uid, title: page.title, children: [] };
          pages.set(page.title, node);
          blocks.set(page.uid, node);
        },
      },
      block: {
        create: async ({ location, block }) => {
          writes.push(["block.create", location["parent-uid"], location.order, block.uid, block.string]);
          const parent = blocks.get(location["parent-uid"]);
          assert.ok(parent, `Missing parent ${location["parent-uid"]}`);
          const node = { uid: block.uid, string: block.string, parentUid: parent.uid, children: [] };
          if (location.order === "last" || location.order >= parent.children.length) {
            parent.children.push(node);
          } else {
            parent.children.splice(location.order, 0, node);
          }
          blocks.set(block.uid, node);
        },
        update: async ({ block }) => {
          writes.push(["block.update", block.uid, block.string]);
          const node = blocks.get(block.uid);
          assert.ok(node, `Missing block ${block.uid}`);
          node.string = block.string;
        },
        delete: async ({ block }) => {
          writes.push(["block.delete", block.uid]);
          const node = blocks.get(block.uid);
          if (!node) return { deleted: false };
          const parent = blocks.get(node.parentUid);
          if (parent) {
            parent.children = parent.children.filter((c) => c.uid !== block.uid);
          }
          blocks.delete(block.uid);
          return { deleted: true };
        },
      },
    },
  };

  return { roamAlphaAPI, pages, blocks, writes };
}

test("syncGuidelinesIndex creates once, writes zero times when unchanged, updates minimal diff, and never touches sibling blocks", async () => {
  const api = makeFakeExtensionAPI({ [SETTING_IDS.guidelinesEnabled]: true });
  const graph = makeFakeRoamGraph({
    initialGuidelinesBlocks: [{ uid: "user-block-1", string: "Papers: what counts as read" }],
  });
  const registry = {
    "roam-grid": {
      name: "Roam Grid",
      description: "Advanced spreadsheet tables.",
      tools: [
        { name: "rg_list", readOnly: true, description: "List grids.", execute: () => ({}) },
        { name: "rg_set", description: "Edit cell.", execute: () => ({}) },
      ],
    },
  };

  const created = await syncGuidelinesIndex({
    extensionAPI: api,
    roamAlphaAPI: graph.roamAlphaAPI,
    getRegistry: () => registry,
  });
  assert.equal(created.status, "created");
  assert.equal(created.writes, 2);
  const storedUid = api.store.get(SETTING_IDS.guidelinesBlockUid);
  assert.equal(storedUid, created.uid);

  const page = graph.pages.get(GUIDELINES_PAGE_TITLE);
  assert.equal(page.children.length, 2);
  assert.equal(page.children[0].string, "Papers: what counts as read");
  assert.equal(page.children[1].string, GUIDELINES_HEADING);
  assert.equal(page.children[1].children.length, 1);
  assert.match(page.children[1].children[0].string, /\*\*Roam Grid\*\*.*2 tools \(1 read, 1 write, writes off\)/);

  // Second sync with identical state -> zero writes.
  const writesBefore = graph.writes.length;
  const unchanged = await syncGuidelinesIndex({
    extensionAPI: api,
    roamAlphaAPI: graph.roamAlphaAPI,
    getRegistry: () => registry,
  });
  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.writes, 0);
  assert.equal(graph.writes.length, writesBefore);

  // Enabling write switch updates only the changed child line.
  await api.settings.set(extensionWriteSettingId("roam-grid"), true);
  const updated = await syncGuidelinesIndex({
    extensionAPI: api,
    roamAlphaAPI: graph.roamAlphaAPI,
    getRegistry: () => registry,
  });
  assert.equal(updated.status, "updated");
  assert.equal(updated.writes, 1);
  assert.match(page.children[1].children[0].string, /writes on/);

  // Adding a second extension creates one new child without disturbing sibling block.
  registry["better-tasks"] = {
    name: "Better Tasks",
    description: "Task management.",
    tools: [{ name: "bt_list", readOnly: true, description: "List tasks.", execute: () => ({}) }],
  };
  const added = await syncGuidelinesIndex({
    extensionAPI: api,
    roamAlphaAPI: graph.roamAlphaAPI,
    getRegistry: () => registry,
  });
  assert.equal(added.status, "updated");
  assert.equal(page.children[1].children.length, 2);
  assert.equal(page.children[0].uid, "user-block-1");
  assert.equal(page.children[0].string, "Papers: what counts as read");

  // Disabling one extension shrinks children back to 1.
  await api.settings.set(extensionEnabledSettingId("roam-grid"), false);
  const shrunk = await syncGuidelinesIndex({
    extensionAPI: api,
    roamAlphaAPI: graph.roamAlphaAPI,
    getRegistry: () => registry,
  });
  assert.equal(shrunk.status, "updated");
  assert.equal(page.children[1].children.length, 1);
  assert.match(page.children[1].children[0].string, /\*\*Better Tasks\*\*/);
});

test("removeGuidelinesIndex deletes only the owned block and preserves user blocks", async () => {
  const api = makeFakeExtensionAPI({ [SETTING_IDS.guidelinesEnabled]: true });
  const graph = makeFakeRoamGraph({
    initialGuidelinesBlocks: [{ uid: "user-block-1", string: "Keep me" }],
  });
  const registry = {
    "demo": {
      name: "Demo",
      tools: [{ name: "ping", readOnly: true, description: "Ping.", execute: () => ({}) }],
    },
  };

  await syncGuidelinesIndex({
    extensionAPI: api,
    roamAlphaAPI: graph.roamAlphaAPI,
    getRegistry: () => registry,
  });

  const removed = await removeGuidelinesIndex({
    extensionAPI: api,
    roamAlphaAPI: graph.roamAlphaAPI,
  });
  assert.equal(removed.status, "removed");
  assert.equal(removed.deleted, true);
  assert.equal(api.store.get(SETTING_IDS.guidelinesBlockUid), null);

  const page = graph.pages.get(GUIDELINES_PAGE_TITLE);
  assert.equal(page.children.length, 1);
  assert.equal(page.children[0].uid, "user-block-1");
});

test("does nothing when setting is disabled (default off)", async () => {
  const api = makeFakeExtensionAPI();
  const graph = makeFakeRoamGraph({ initialGuidelinesBlocks: null });

  const result = await syncGuidelinesIndex({
    extensionAPI: api,
    roamAlphaAPI: graph.roamAlphaAPI,
    getRegistry: () => ({}),
  });
  assert.equal(result.status, "disabled");
  assert.equal(graph.writes.length, 0);
  assert.equal(graph.pages.size, 0);
});

test("above 20 enabled extensions writes grouped counts and points at list_extensions", () => {
  const extensions = [];
  for (let i = 1; i <= 22; i += 1) {
    extensions.push({
      key: `ext-${i}`,
      name: `Extension ${i}`,
      group: i <= 10 ? "Tasks" : i <= 18 ? "Visual" : null,
      toolCount: 2,
      readCount: 1,
      writeCount: 1,
      summary: `Summary ${i}`,
    });
  }
  const model = buildGuidelinesIndexModel({ extensions });
  assert.equal(model.heading, GUIDELINES_HEADING);
  assert.deepEqual(model.children, [
    "Tasks: 10 extensions (20 tools)",
    "Visual: 8 extensions (16 tools)",
    "Other: 4 extensions (8 tools)",
    "Total: 22 enabled extensions (44 tools). Call list_extensions to browse them.",
  ]);
});
