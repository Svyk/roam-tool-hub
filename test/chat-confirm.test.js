import assert from "node:assert/strict";
import test from "node:test";

import { createChatConfirm } from "../src/chat-confirm.js";

function fakeDocument() {
  const innerHtmlWrites = [];
  const make = (tag) => {
    const node = {
      tag,
      children: [],
      attributes: {},
      listeners: {},
      className: "",
      textContent: "",
      parent: null,
      append(...nodes) {
        for (const child of nodes) {
          child.parent = node;
          node.children.push(child);
        }
      },
      remove() {
        if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
        node.parent = null;
      },
      setAttribute(name, value) {
        node.attributes[name] = value;
      },
      addEventListener(type, fn) {
        (node.listeners[type] ||= []).push(fn);
      },
      click() {
        for (const fn of node.listeners.click ?? []) fn({});
      },
    };
    Object.defineProperty(node, "innerHTML", {
      get: () => "",
      set: (value) => innerHtmlWrites.push(value),
    });
    return node;
  };
  const body = make("body");
  return { createElement: make, body, innerHtmlWrites };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function find(root, predicate) {
  const found = [];
  walk(root, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

function buttons(doc) {
  return find(doc.body, (node) => node.tag === "button");
}

function request(overrides = {}) {
  return {
    toolName: "rg_sort",
    extensionName: "Roam Grid",
    description: "Sort a grid.",
    args: { uid: "u1" },
    ...overrides,
  };
}

test("the dialog has the Blueprint structure and three buttons", async () => {
  const doc = fakeDocument();
  const confirm = createChatConfirm({ documentRef: doc });
  const pending = confirm.confirm(request());

  const [backdrop] = doc.body.children;
  assert.equal(backdrop.className, "rth-confirm-backdrop");
  const [dialog] = backdrop.children;
  assert.equal(dialog.className, "bp3-dialog rth-confirm");
  assert.equal(dialog.attributes.role, "dialog");
  assert.equal(dialog.attributes["aria-modal"], "true");
  const heading = find(dialog, (node) => node.tag === "h4")[0];
  assert.equal(heading.className, "bp3-heading");
  assert.equal(heading.textContent, "Allow this change?");
  assert.equal(dialog.attributes["aria-labelledby"], heading.id);
  const texts = find(dialog, (node) => node.tag === "p").map((node) => node.textContent);
  assert.deepEqual(texts, ["Roam Grid wants to run rg_sort.", "Sort a grid."]);
  assert.equal(find(dialog, (node) => node.tag === "pre")[0].textContent, JSON.stringify({ uid: "u1" }, null, 2));
  assert.equal(find(dialog, (node) => node.className === "bp3-dialog-footer-actions").length, 1);

  assert.deepEqual(buttons(doc).map((node) => node.textContent), ["Deny", "Allow Roam Grid in this chat", "Allow once"]);
  assert.match(buttons(doc)[2].className, /bp3-intent-primary/);
  assert.equal(Object.keys(dialog.listeners).length, 0);
  assert.equal(Object.keys(doc.body.listeners).length, 0);
  buttons(doc)[0].click();
  assert.equal(await pending, "deny");
});

test("each button resolves its own decision and removes the dialog", async () => {
  for (const [index, expected] of [[0, "deny"], [1, "chat"], [2, "once"]]) {
    const doc = fakeDocument();
    const confirm = createChatConfirm({ documentRef: doc });
    const pending = confirm.confirm(request());
    buttons(doc)[index].click();
    assert.equal(await pending, expected);
    assert.equal(doc.body.children.length, 0);
  }
});

test("allowChat false shows only Deny and Allow once", async () => {
  for (const [index, expected] of [[0, "deny"], [1, "once"]]) {
    const doc = fakeDocument();
    const confirm = createChatConfirm({ documentRef: doc });
    const pending = confirm.confirm(request({ allowChat: false }));
    const btns = buttons(doc);
    assert.deepEqual(btns.map((node) => node.textContent), ["Deny", "Allow once"]);
    assert.match(btns[1].className, /bp3-intent-primary/);
    btns[index].click();
    assert.equal(await pending, expected);
    assert.equal(doc.body.children.length, 0);
  }
});

test("requests queue and show one at a time", async () => {
  const doc = fakeDocument();
  const confirm = createChatConfirm({ documentRef: doc });
  const first = confirm.confirm(request({ toolName: "first_tool" }));
  const second = confirm.confirm(request({ toolName: "second_tool" }));
  assert.equal(doc.body.children.length, 1);
  assert.match(find(doc.body, (node) => node.tag === "p")[0].textContent, /first_tool/);

  buttons(doc)[2].click();
  assert.equal(await first, "once");
  assert.equal(doc.body.children.length, 1);
  assert.match(find(doc.body, (node) => node.tag === "p")[0].textContent, /second_tool/);
  buttons(doc)[0].click();
  assert.equal(await second, "deny");
  assert.equal(doc.body.children.length, 0);
});

test("an already aborted signal resolves deny without showing anything", async () => {
  const doc = fakeDocument();
  const confirm = createChatConfirm({ documentRef: doc });
  const controller = new AbortController();
  controller.abort();
  assert.equal(await confirm.confirm(request({ signal: controller.signal })), "deny");
  assert.equal(doc.body.children.length, 0);
});

test("aborting while open removes the dialog and shows the next request", async () => {
  const doc = fakeDocument();
  const confirm = createChatConfirm({ documentRef: doc });
  const controller = new AbortController();
  const first = confirm.confirm(request({ toolName: "first_tool", signal: controller.signal }));
  const second = confirm.confirm(request({ toolName: "second_tool" }));
  controller.abort();
  assert.equal(await first, "deny");
  assert.equal(doc.body.children.length, 1);
  assert.match(find(doc.body, (node) => node.tag === "p")[0].textContent, /second_tool/);
  buttons(doc)[2].click();
  assert.equal(await second, "once");
});

test("a queued request that aborts is skipped when its turn comes", async () => {
  const doc = fakeDocument();
  const confirm = createChatConfirm({ documentRef: doc });
  const controller = new AbortController();
  const first = confirm.confirm(request({ toolName: "first_tool" }));
  const second = confirm.confirm(request({ toolName: "second_tool", signal: controller.signal }));
  const third = confirm.confirm(request({ toolName: "third_tool" }));
  controller.abort();
  assert.equal(await second, "deny");
  buttons(doc)[2].click();
  assert.equal(await first, "once");
  assert.equal(doc.body.children.length, 1);
  assert.match(find(doc.body, (node) => node.tag === "p")[0].textContent, /third_tool/);
  buttons(doc)[0].click();
  assert.equal(await third, "deny");
});

test("dispose removes the open dialog and denies everything queued", async () => {
  const doc = fakeDocument();
  const confirm = createChatConfirm({ documentRef: doc });
  const first = confirm.confirm(request());
  const second = confirm.confirm(request());
  confirm.dispose();
  assert.equal(await first, "deny");
  assert.equal(await second, "deny");
  assert.equal(doc.body.children.length, 0);
  assert.equal(await confirm.confirm(request()), "deny");
  assert.equal(doc.body.children.length, 0);
});

test("long arguments are cut at 2000 characters with a note", async () => {
  const doc = fakeDocument();
  const confirm = createChatConfirm({ documentRef: doc });
  const pending = confirm.confirm(request({ args: { text: "x".repeat(5000) } }));
  const text = find(doc.body, (node) => node.tag === "pre")[0].textContent;
  assert.ok(text.length < 2100);
  assert.match(text, /\(cut\)$/);
  assert.equal(text.startsWith('{\n  "text": "xxx'), true);
  buttons(doc)[0].click();
  await pending;
});

test("no document means deny, and the dialog never writes innerHTML", async () => {
  const none = createChatConfirm({ documentRef: null });
  assert.equal(await none.confirm(request()), "deny");

  const doc = fakeDocument();
  const confirm = createChatConfirm({ documentRef: doc });
  const pending = confirm.confirm(request({ extensionName: "<img src=x onerror=alert(1)>", args: { html: "<b>x</b>" } }));
  const sentence = find(doc.body, (node) => node.tag === "p")[0];
  assert.equal(sentence.textContent, "<img src=x onerror=alert(1)> wants to run rg_sort.");
  buttons(doc)[0].click();
  await pending;
  assert.deepEqual(doc.innerHtmlWrites, []);
});
