import assert from "node:assert/strict";
import test from "node:test";

import {
  FIND_TOOL_NAME,
  MAX_GUIDE_CHARS,
  MAX_PRELOAD,
  buildChatCatalog,
  deriveChatAccess,
  findExtensionTools,
  isDestructiveToolName,
  readNativeExtensions,
  renderIndexSection,
  suggestTools,
  tokenize,
} from "../src/chat-catalog.js";
import { MAX_GUIDE_CHARS as CONSTANT_MAX_GUIDE_CHARS } from "../src/constants.js";
import { readRegistrySnapshot } from "../src/registry.js";
import { extensionEnabledSettingId, extensionWriteSettingId } from "../src/settings.js";
import { buildRegistryFromFixture } from "./helpers/fake-pi.js";

function settingsApi(values = {}) {
  return { settings: { canSet: true, get: (key) => (key in values ? values[key] : null) } };
}

function allOn(keys) {
  const values = {};
  for (const key of keys) {
    values[extensionEnabledSettingId(key)] = true;
    values[extensionWriteSettingId(key)] = true;
  }
  return values;
}

function fixtureCatalog({ values, registry = buildRegistryFromFixture(), native = [] } = {}) {
  const snapshot = readRegistrySnapshot(() => registry);
  const keys = [...snapshot.extensions.map((ext) => ext.key), ...native.map((ext) => ext.key)];
  return buildChatCatalog({
    registryExtensions: snapshot.extensions,
    nativeExtensions: native,
    extensionAPI: settingsApi(values ?? allOn(keys)),
  });
}

function simpleExt(key, name, tools, extra = {}) {
  return {
    key,
    name,
    summary: `${name} summary`,
    guide: "",
    tools: tools.map((tool) => ({
      id: `${key}/${tool.name}`,
      name: tool.name,
      description: tool.description ?? `${tool.name} does a thing.`,
      shortDescription: tool.description ?? `${tool.name} does a thing.`,
      readOnly: tool.readOnly === true,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    })),
    ...extra,
  };
}

test("MAX_GUIDE_CHARS lives in constants and is re-exported by the catalog", () => {
  assert.equal(MAX_GUIDE_CHARS, CONSTANT_MAX_GUIDE_CHARS);
  assert.equal(MAX_GUIDE_CHARS, 900);
});

test("write switch off hides writing tools, extension switch off hides the extension, hiddenWriteCount counts", () => {
  const registry = buildRegistryFromFixture();
  const snapshot = readRegistrySnapshot(() => registry);
  const grid = snapshot.byKey.get("roam-grid");

  const readOnly = fixtureCatalog({ values: {} });
  const gridRecord = readOnly.extensions.find((ext) => ext.key === "roam-grid");
  assert.ok(gridRecord.tools.every((tool) => tool.readOnly));
  assert.equal(gridRecord.hiddenWriteCount, grid.writeCount);
  assert.ok(gridRecord.hiddenWriteCount > 0);
  // An extension with no read tools at all disappears while its write switch is off.
  assert.equal(readOnly.extensions.find((ext) => ext.key === "oblique-strategies"), undefined);

  const withWrites = fixtureCatalog({ values: { [extensionWriteSettingId("roam-grid")]: true } });
  assert.equal(withWrites.extensions.find((ext) => ext.key === "roam-grid").hiddenWriteCount, 0);
  assert.ok(withWrites.tools.some((tool) => tool.name === "rg_sort"));

  const off = fixtureCatalog({ values: { ...allOn(["roam-grid"]), [extensionEnabledSettingId("roam-grid")]: false } });
  assert.equal(off.extensions.find((ext) => ext.key === "roam-grid"), undefined);
  assert.equal(off.tools.some((tool) => tool.extensionKey === "roam-grid"), false);
});

test("chat names: plain kept, Roam clashes and duplicates get distinct valid names", () => {
  const extensions = [
    simpleExt("ext-a", "Ext A", [{ name: "plain_tool" }, { name: "search" }, { name: "shared" }, { name: "bad name!" }, { name: "get_page" }]),
    simpleExt("ext-b", "Ext B", [{ name: "shared" }]),
  ];
  const catalog = buildChatCatalog({ registryExtensions: extensions, extensionAPI: settingsApi(allOn(["ext-a", "ext-b"])) });
  const byId = new Map(catalog.tools.map((tool) => [tool.id, tool.chatName]));
  assert.equal(byId.get("ext-a/plain_tool"), "plain_tool");
  assert.equal(byId.get("ext-a/search"), "ext-a__search");
  assert.equal(byId.get("ext-a/get_page"), "ext-a__get_page");
  assert.equal(byId.get("ext-a/shared"), "shared");
  assert.equal(byId.get("ext-b/shared"), "ext-b__shared");
  assert.equal(byId.get("ext-a/bad name!"), "bad_name");
  const names = catalog.tools.map((tool) => tool.chatName);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(names.includes(FIND_TOOL_NAME), false);
});

test("chat names stay valid for a very long or empty-after-cleaning name", () => {
  const extensions = [simpleExt("ext-a", "Ext A", [{ name: "x".repeat(100) }, { name: "!!!" }])];
  const catalog = buildChatCatalog({ registryExtensions: extensions, extensionAPI: settingsApi(allOn(["ext-a"])) });
  for (const tool of catalog.tools) assert.match(tool.chatName, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(new Set(catalog.tools.map((tool) => tool.chatName)).size, 2);
});

test("readNativeExtensions groups by extension, strips the id prefix, maps scope, drops Tool Hub's own group", () => {
  const raw = [
    { tool: "https://x.github.io/plexus-diagram//add_cards", extension: "https://x.github.io/plexus-diagram/", description: "Add cards. More.", scope: "edit", inputSchema: { type: "object", properties: { n: { type: "number" } } } },
    { tool: "https://x.github.io/plexus-diagram//list_cards", extension: "https://x.github.io/plexus-diagram/", description: "List cards.", scope: "read" },
    { tool: "https://hub.example/tool-hub//list_extensions", extension: "https://hub.example/tool-hub/", description: "x", scope: "read" },
    { tool: "https://hub.example/tool-hub//describe_tools", extension: "https://hub.example/tool-hub/", description: "x", scope: "read" },
    { tool: "https://hub.example/tool-hub//run_read_tool", extension: "https://hub.example/tool-hub/", description: "x", scope: "read" },
    { tool: "", description: "ignored" },
    null,
  ];
  const extensions = readNativeExtensions(raw);
  assert.equal(extensions.length, 1);
  const [ext] = extensions;
  assert.equal(ext.key, "native:https://x.github.io/plexus-diagram/");
  assert.equal(ext.name, "Plexus Diagram");
  assert.equal(ext.native, true);
  assert.deepEqual(ext.tools.map((tool) => tool.name), ["add_cards", "list_cards"]);
  assert.equal(ext.tools[0].readOnly, false);
  assert.equal(ext.tools[1].readOnly, true);
  assert.equal(ext.tools[0].id, "https://x.github.io/plexus-diagram//add_cards");
  assert.equal(ext.readCount, 1);
  assert.equal(ext.writeCount, 1);
  assert.deepEqual(readNativeExtensions(null), []);
});

test("native tools join the catalog under their prefixed key", () => {
  const native = readNativeExtensions([
    { tool: "https://x.github.io/plexus-diagram//search", extension: "https://x.github.io/plexus-diagram/", description: "Search cards.", scope: "read" },
  ]);
  const catalog = fixtureCatalog({ native });
  const tool = catalog.tools.find((entry) => entry.native);
  assert.equal(tool.chatName, "plexus-diagram__search");
  assert.equal(tool.extensionKey, "native:https://x.github.io/plexus-diagram/");
});

test("deriveChatAccess reads Roam's tool list", () => {
  assert.equal(deriveChatAccess(["get_page", "search", "create_block", "update_block"]), "edit");
  assert.equal(deriveChatAccess(["get_page", "create_block"]), "append");
  assert.equal(deriveChatAccess(["get_page", "search"]), "read");
  assert.equal(deriveChatAccess(undefined), "read");
});

test("suggestTools picks the right tools for clear requests", () => {
  const catalog = fixtureCatalog();
  const names = (text, options) => suggestTools(catalog, text, { access: "edit", ...options }).map((tool) => tool.chatName);

  const sort = names("Sort the grocery table by price, highest first");
  assert.ok(sort.includes("rg_sort"), sort.join());
  assert.ok(sort.includes("rg_list_grids"), sort.join());

  const task = names("Create a task to call the dentist, due Friday, in the Health project");
  assert.ok(task.includes("bt_create"), task.join());
  assert.ok(task.includes("bt_search"), task.join());

  assert.deepEqual(names("Give me an oblique strategy for this draft"), ["os_random_strategy"]);
  assert.ok(names("What are my waiting-for items?").includes("bt_get_waiting_for"));
  assert.ok(names("Export every task in my graph as CSV.").includes("bt_export"));
});

function fullNativeRaw() {
  return [
    {
      tool: "https://svyk.github.io/plexus-diagram//list_boards",
      extension: "https://svyk.github.io/plexus-diagram/",
      description: "Lists the Plexus whiteboards in this graph with their uid, title, page and card count. Use it first to find a board uid. Up to 200 boards.",
      scope: "read",
      inputSchema: { type: "object", properties: { page: { type: "string" } } },
    },
    {
      tool: "https://svyk.github.io/plexus-diagram//read_board",
      extension: "https://svyk.github.io/plexus-diagram/",
      description: "Reads one Plexus board: its outline as text, plus every section, card and arrow with world rectangles. Use it before changing a board. Returns at most 500 cards and 40000 characters of text.",
      scope: "read",
      inputSchema: { type: "object", properties: { board: { type: "string" } }, required: ["board"] },
    },
    {
      tool: "https://svyk.github.io/plexus-diagram//add_cards",
      extension: "https://svyk.github.io/plexus-diagram/",
      description: "Adds cards to a board. Each card is plain text, one [[Page]] link or one ((block uid)).",
      scope: "edit",
      inputSchema: { type: "object", properties: { board: { type: "string" }, cards: { type: "array" }, section: { type: "string" } } },
    },
    {
      tool: "https://svyk.github.io/plexus-diagram//add_section",
      extension: "https://svyk.github.io/plexus-diagram/",
      description: "Adds an empty titled section (a frame that groups cards) to a board.",
      scope: "append",
      inputSchema: { type: "object", properties: { board: { type: "string" }, title: { type: "string" } } },
    },
    {
      tool: "https://svyk.github.io/plexus-diagram//connect_cards",
      extension: "https://svyk.github.io/plexus-diagram/",
      description: "Draws an arrow between two items on a board, with an optional label.",
      scope: "append",
      inputSchema: { type: "object", properties: { board: { type: "string" }, from: { type: "string" }, to: { type: "string" } } },
    },
    {
      tool: "https://svyk.github.io/plexus-diagram//arrange_board",
      extension: "https://svyk.github.io/plexus-diagram/",
      description: "Re-lays out cards in a grid, a row, a column or an outline.",
      scope: "edit",
      inputSchema: { type: "object", properties: { board: { type: "string" }, mode: { type: "string" } } },
    },
    {
      tool: "https://svyk.github.io/Roam-Task-Status-Tags//list_statuses",
      extension: "https://svyk.github.io/Roam-Task-Status-Tags/",
      description: "Lists every task status configured in this graph with its tag, group (task, media, or extra), whether click-to-cycle visits it, and the tag format used on task blocks.",
      scope: "read",
      inputSchema: { type: "object", properties: {} },
    },
    {
      tool: "https://svyk.github.io/Roam-Task-Status-Tags//get_task_status",
      extension: "https://svyk.github.io/Roam-Task-Status-Tags/",
      description: "Reads the current workflow status and TODO/DONE state for 1 to 50 blocks by uid.",
      scope: "read",
      inputSchema: { type: "object", properties: { uids: { type: "array" } } },
    },
    {
      tool: "https://svyk.github.io/Roam-Task-Status-Tags//list_tasks",
      extension: "https://svyk.github.io/Roam-Task-Status-Tags/",
      description: "Lists tasks that carry a configured task status tag, optionally filtered to one status.",
      scope: "read",
      inputSchema: { type: "object", properties: { status: { type: "string" }, include_done: { type: "boolean" }, limit: { type: "integer" } } },
    },
    {
      tool: "https://svyk.github.io/Roam-Task-Status-Tags//status_counts",
      extension: "https://svyk.github.io/Roam-Task-Status-Tags/",
      description: "Counts tasks per configured status across the graph, including statuses with zero tasks.",
      scope: "read",
      inputSchema: { type: "object", properties: { include_done: { type: "boolean" } } },
    },
    {
      tool: "https://svyk.github.io/Roam-Task-Status-Tags//set_task_status",
      extension: "https://svyk.github.io/Roam-Task-Status-Tags/",
      description: "Sets or clears the workflow status on 1 to 10 existing TODO or DONE tasks.",
      scope: "edit",
      inputSchema: { type: "object", properties: { changes: { type: "array" } } },
    },
  ];
}

function fullCatalog() {
  const registry = buildRegistryFromFixture();
  const snapshot = readRegistrySnapshot(() => registry);
  const native = readNativeExtensions(fullNativeRaw());
  const values = allOn(snapshot.extensions.map((ext) => ext.key));
  for (const ext of native) {
    values[extensionEnabledSettingId(ext.key)] = true;
    values[extensionWriteSettingId(ext.key)] = false;
  }
  return fixtureCatalog({ registry, native, values });
}

test("suggestTools stays quiet on everyday notes and false-compound traps with full fixture and native tools", () => {
  const catalog = fullCatalog();
  const quietPrompts = [
    "Rewrite this note so the tone is more comfortable and natural.",
    "Make a roast vegetables shopping list on today's daily note.",
    "What are two alternative phrasings for this opening paragraph?",
    "What keyboard shortcuts move a block up and down in Roam?",
    "Clean up the formatting of this text I pasted from my clipboard.",
    "Draft a morning dispatch note for the sanitation shift lead.",
    "Check if there are any vendor discounts mentioned in Lab Supplies.",
    "Sketch a text flowchart of the pasteurization decision tree.",
    "Write a detailed summary of Out of the Silent Planet.",
    "Suggest a crisper title for today's meeting notes.",
    "Exporting my notes to PDF after proofreading.",
    "Please proofread this paragraph and make a checklist",
    "Export my graph to an Anki flashcard deck (.apkg) and email it to me.",
  ];
  for (const text of quietPrompts) {
    assert.deepEqual(
      suggestTools(catalog, text, { access: "edit" }).map((tool) => tool.chatName),
      [],
      text,
    );
  }
});

test("suggestTools uses query aliases to match whiteboards, spreadsheets, datagrids, subtasks and todos", () => {
  const catalog = fullCatalog();
  const names = (text) => suggestTools(catalog, text, { access: "edit" }).map((tool) => tool.chatName);

  const boards = names("What whiteboards do I have, and what's on the smallest one?");
  assert.ok(boards.includes("list_boards"), boards.join());
  assert.ok(boards.includes("read_board"), boards.join());

  const spreadsheets = names("Do I have any spreadsheets tracking weekly expenses?");
  assert.ok(spreadsheets.includes("rg_list_grids"), spreadsheets.join());

  const datagrids = names("List all datagrids on this page.");
  assert.ok(datagrids.includes("rg_list_grids"), datagrids.join());

  const subtasks = suggestTools(catalog, "Show me all open subtasks due this week.", { access: "edit" });
  assert.ok(
    subtasks.some((tool) => tool.extensionKey === "better-tasks" && tool.readOnly),
    subtasks.map((t) => t.chatName).join(),
  );

  const todos = suggestTools(catalog, "Show my overdue todos", { access: "edit" });
  assert.ok(
    todos.some((tool) => tool.extensionKey === "better-tasks" && tool.readOnly),
    todos.map((t) => t.chatName).join(),
  );

  assert.ok(names("Export every task in my graph as CSV.").includes("bt_export"));
});

test("suggestTools finds a request in the middle of an 87-token prompt and keeps head and tail past 120 tokens", () => {
  const catalog = fullCatalog();
  const fillerA = [
    "During Monday morning lab review we discussed pasteurization temperatures microbial lethality",
    "decimal reduction times spore germination kinetics stainless steel surface roughness hygienic",
    "welding standards cleanroom pressure differentials air filtration efficiency gowning compliance",
    "operator handwashing logs shift handover checklists reagent expiration dates incubator",
  ].join(" ");
  const fillerB = [
    "Furthermore Tuesday afternoon notes covered supplier certificates mycotoxin screening heavy",
    "metal limits infant fortification premix homogeneity dry blending validation",
    "environmental monitoring zones Listeria monocytogenes Cronobacter sakazakii swabbing locations",
    "corrective action root cause investigations regulatory inspection readiness audit trails",
  ].join(" ");
  const middlePrompt = `${fillerA} Please sort the swabbing table by zone using the context below: ${fillerB} thermal profiling verification`;
  const middleTokens = tokenize(middlePrompt);
  assert.equal(middleTokens.length, 87, `expected 87 tokens, got ${middleTokens.length}`);
  const middleNames = suggestTools(catalog, middlePrompt, { access: "edit" }).map((tool) => tool.chatName);
  assert.ok(middleNames.includes("rg_sort"), middleNames.join());

  const extraFiller = Array.from({ length: 50 }, (_, i) => `appendixtoken${i}`).join(" ");
  const longText = `${fillerA} ${extraFiller} ${fillerB}`;
  assert.ok(tokenize(longText).length > 120);
  const tailAsk = `${longText} After all that background, please check what task statuses are configured and give me an oblique strategy.`;
  const tailNames = suggestTools(catalog, tailAsk, { access: "edit" }).map((tool) => tool.chatName);
  assert.ok(tailNames.includes("os_random_strategy"), tailNames.join());
  assert.ok(tailNames.includes("list_statuses"), tailNames.join());

  const headAsk = `Give me an oblique strategy for these notes: ${longText}`;
  const headNames = suggestTools(catalog, headAsk, { access: "edit" }).map((tool) => tool.chatName);
  assert.ok(headNames.includes("os_random_strategy"), headNames.join());
});

test("suggestTools ignores template tools as companions and picks locators by score first", () => {
  const catalog = fullCatalog();
  const createTask = suggestTools(
    catalog,
    "Create a task '[stress] Review lab checklist' due December 2, 2026 in the project Stress Test",
    { access: "edit" },
  ).map((tool) => tool.chatName);
  assert.ok(createTask.includes("bt_create"), createTask.join());
  assert.ok(createTask.includes("bt_search"), createTask.join());
  assert.equal(createTask.includes("bt_list_templates"), false, createTask.join());

  const withTemplateExcluded = suggestTools(
    catalog,
    "Modify the calibration task uid k9Lm2pQr8 so its priority is high.",
    { access: "edit", exclude: ["bt_list_templates"] },
  ).map((tool) => tool.chatName);
  assert.ok(withTemplateExcluded.includes("bt_modify"), withTemplateExcluded.join());
  assert.ok(withTemplateExcluded.includes("bt_search"), withTemplateExcluded.join());

  const formulaFollowUp = suggestTools(
    catalog,
    "Add a bottom row named Total with formulas summing the Caffeine and Price columns",
    { access: "edit", exclude: ["rg_list_grids", "rg_get_grid"] },
  ).map((tool) => tool.chatName);
  assert.ok(formulaFollowUp.includes("rg_add_formula"), formulaFollowUp.join());
  assert.equal(formulaFollowUp.includes("rg_list_templates"), false, formulaFollowUp.join());

  // Locator is chosen by score first (highest score beats earlier registration order),
  // and a template tool is never selected as a companion.
  const custom = buildChatCatalog({
    registryExtensions: [
      simpleExt("widgets", "Widgets", [
        { name: "w_list_templates", readOnly: true, description: "List saved widget templates." },
        { name: "w_list_alpha", readOnly: true, description: "List alpha entries." },
        { name: "w_search_sprockets", readOnly: true, description: "Search sprockets by label." },
        { name: "w_update_sprocket", readOnly: false, description: "Update a sprocket calibration value." },
      ]),
    ],
    extensionAPI: settingsApi(allOn(["widgets"])),
  });
  const picked = suggestTools(custom, "Update sprocket calibration", { access: "edit", max: 2 }).map((t) => t.chatName);
  assert.deepEqual(picked, ["w_update_sprocket", "w_search_sprockets"]);

  const onlyTemplate = buildChatCatalog({
    registryExtensions: [
      simpleExt("tmpl-only", "Template Only", [
        { name: "t_list_templates", readOnly: true, description: "List saved templates." },
        { name: "t_apply_blueprint_schematic", readOnly: false, description: "Apply a blueprint schematic diagram." },
      ]),
    ],
    extensionAPI: settingsApi(allOn(["tmpl-only"])),
  });
  const noTemplateCompanion = suggestTools(onlyTemplate, "Apply blueprint schematic diagram", { access: "edit" }).map((t) => t.chatName);
  assert.deepEqual(noTemplateCompanion, ["t_apply_blueprint_schematic"]);
});

test("isDestructiveToolName flags deleting and bulk tool names and flows into catalog entries and signature", () => {
  for (const name of ["bt_delete", "bt_bulk_snooze", "rg_delete_rows", "rg_restore_native", "clear_cache", "archive-old", "dropTable_wipe"]) {
    assert.equal(isDestructiveToolName(name), true, name);
  }
  for (const name of ["bt_create", "rg_set_cell", "rg_sort", "rg_list_grids", "bt_search"]) {
    assert.equal(isDestructiveToolName(name), false, name);
  }
  // Uses the original tool name, not a prefixed chat name from an extension key.
  const ext = [simpleExt("delete-ext", "Delete Ext", [{ name: "search" }, { name: "remove_entry" }])];
  const catalog = buildChatCatalog({ registryExtensions: ext, extensionAPI: settingsApi(allOn(["delete-ext"])) });
  const renamed = catalog.tools.find((t) => t.name === "search");
  assert.equal(renamed.chatName, "delete-ext__search");
  assert.equal(renamed.destructive, false);
  const destructive = catalog.tools.find((t) => t.name === "remove_entry");
  assert.equal(destructive.destructive, true);
  assert.ok(catalog.signature.includes("true") && catalog.signature.includes("false"));
});

test("suggestTools stays quiet for requests that need no extension", () => {
  const catalog = fixtureCatalog();
  for (const text of [
    "Summarize what I wrote in yesterday daily note",
    "Rewrite this paragraph to be shorter",
    "Turn this list into a kanban",
    "Find every page that links to Food Safety",
    "Add a block under today saying hello",
    "Who is Lori Boyd?",
  ]) {
    assert.deepEqual(suggestTools(catalog, text, { access: "edit" }).map((tool) => tool.chatName), [], text);
  }
});

test("suggestTools respects max, exclude and read-only access", () => {
  const catalog = fixtureCatalog();
  const text = "Sort the grocery table by price, highest first";
  const all = suggestTools(catalog, text, { access: "edit" });
  assert.ok(all.length > 0 && all.length <= MAX_PRELOAD);
  assert.ok(suggestTools(catalog, text, { access: "edit", max: 3 }).length <= 3);
  const excluded = suggestTools(catalog, text, { access: "edit", exclude: ["rg_sort"] });
  assert.equal(excluded.some((tool) => tool.chatName === "rg_sort"), false);
  const read = suggestTools(catalog, text, { access: "read" });
  assert.ok(read.every((tool) => tool.readOnly));
  const readTask = suggestTools(catalog, "Create a task to call the dentist, due Friday, in the Health project", { access: "read" });
  assert.ok(readTask.every((tool) => tool.readOnly));
});

test("findExtensionTools by names: exact, wildcard marker, extKey/tool id, unknown", () => {
  const catalog = fixtureCatalog();
  const exact = findExtensionTools({ names: ["rg_sort", "rg_get_grid"] }, { catalog });
  assert.deepEqual(exact.load, ["rg_sort", "rg_get_grid"]);

  const starred = findExtensionTools({ names: ["rg_sort*"] }, { catalog });
  assert.deepEqual(starred.load, ["rg_sort"]);

  const byId = findExtensionTools({ names: ["roam-grid/rg_sort"] }, { catalog });
  assert.deepEqual(byId.load, ["rg_sort"]);

  const unknown = findExtensionTools({ names: ["nope_tool", "rg_sort"] }, { catalog });
  assert.deepEqual(unknown.load, ["rg_sort"]);
  assert.equal(unknown.payload.not_loaded[0].name, "nope_tool");
});

test("findExtensionTools by query, extension and limit", () => {
  const catalog = fixtureCatalog();
  const byQuery = findExtensionTools({ query: "oblique strategy" }, { catalog });
  assert.ok(byQuery.load.includes("os_random_strategy"));

  const byExtension = findExtensionTools({ extension: "better-tasks" }, { catalog });
  assert.ok(byExtension.load.length > 0);
  assert.ok(byExtension.load.every((name) => name.startsWith("bt_")));

  const byName = findExtensionTools({ extension: "Roam Grid", limit: 2 }, { catalog });
  assert.equal(byName.load.length, 2);
  assert.ok(byName.payload.more);

  assert.equal(findExtensionTools({ limit: 0 }, { catalog }).load.length, 1);
  assert.equal(findExtensionTools({ limit: 500 }, { catalog }).load.length, 15);
  assert.equal(findExtensionTools({ query: "zzzzqqqq" }, { catalog }).load.length, 0);
});

test("findExtensionTools in a read-only chat drops writing tools and says why when asked by name", () => {
  const catalog = fixtureCatalog();
  const result = findExtensionTools({ names: ["rg_sort", "rg_get_grid"] }, { catalog, access: "read" });
  assert.deepEqual(result.load, ["rg_get_grid"]);
  assert.equal(result.payload.not_loaded[0].name, "rg_sort");
  const searched = findExtensionTools({ extension: "roam-grid", limit: 15 }, { catalog, access: "read" });
  assert.ok(searched.load.every((name) => catalog.byName.get(name).readOnly));
});

test("findExtensionTools returns a guide only the first time for one guidesSent set", () => {
  const registry = buildRegistryFromFixture();
  registry["roam-grid"].guide = "Grids are tables.   Use rg_sort to sort.";
  const catalog = fixtureCatalog({ registry });
  const guidesSent = new Set();
  const first = findExtensionTools({ names: ["rg_sort"] }, { catalog, guidesSent });
  assert.deepEqual(first.payload.guides, { "Roam Grid": "Grids are tables. Use rg_sort to sort." });
  const second = findExtensionTools({ names: ["rg_get_grid"] }, { catalog, guidesSent });
  assert.equal(second.payload.guides, undefined);
  const other = findExtensionTools({ names: ["rg_sort"] }, { catalog, guidesSent: new Set() });
  assert.ok(other.payload.guides);
});

test("renderIndexSection returns nothing without tools and marks writing tools", () => {
  assert.equal(renderIndexSection(buildChatCatalog({})), undefined);

  const catalog = fixtureCatalog();
  const text = renderIndexSection(catalog, { access: "edit" });
  assert.match(text, /Roam Grid/);
  assert.match(text, /Better Tasks/);
  assert.match(text, /rg_sort\*/);
  assert.match(text, /rg_get_grid(?!\*)/);
  assert.match(text, new RegExp(FIND_TOOL_NAME));
  assert.match(
    text,
    /A tool that is already in your tool list can be called directly\.[^\n]*\nTools are put in your list by matching words in the person's message, so a tool being there does not mean it is wanted\. Use one only when the request is really about what that extension manages\./,
  );
  assert.doesNotMatch(text, /read-only/);
});

test("renderIndexSection in a read-only chat lists no writing tool names", () => {
  const catalog = fixtureCatalog();
  const text = renderIndexSection(catalog, { access: "read" });
  assert.doesNotMatch(text, /\w\*/);
  assert.doesNotMatch(text, /rg_sort/);
  assert.match(text, /read-only/);
});

test("renderIndexSection includes a guide only for an extension with a loaded tool", () => {
  const registry = buildRegistryFromFixture();
  registry["roam-grid"].guide = "GRID-GUIDE-TEXT";
  registry["better-tasks"].guide = "TASK-GUIDE-TEXT";
  const catalog = fixtureCatalog({ registry });
  const none = renderIndexSection(catalog, { access: "edit", loadedNames: [] });
  assert.doesNotMatch(none, /GUIDE-TEXT/);
  const loaded = renderIndexSection(catalog, { access: "edit", loadedNames: ["rg_sort"] });
  assert.match(loaded, /GRID-GUIDE-TEXT/);
  assert.doesNotMatch(loaded, /TASK-GUIDE-TEXT/);
});
