#!/usr/bin/env node
// Drives Roam Desktop's built-in AI chat through the debug port, one turn per run.
//
//   node chat-driver.mjs "prompt text" [--new] [--confirm once|chat|deny] [--access <menu text>]
//                        [--timeout 240] [--window Readwisenotes] [--trace]
//
// Prints one JSON object: the reply, the tool calls the panel shows, what the confirm dialog
// asked, Tool Hub's bridge counters before and after, and console lines from Tool Hub.
// Refuses any window that is not the named test graph. It never reloads the page.

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, value === undefined || value.startsWith("--") ? 1 : 2);
  return value === undefined || value.startsWith("--") ? true : value;
}
const windowName = flag("window", "Readwisenotes");
const newChat = flag("new", false) === true;
const confirmPolicy = flag("confirm", "deny");
const accessText = flag("access", null);
const timeoutSec = Number(flag("timeout", 240));
const trace = flag("trace", false) === true;
const prompt = args.join(" ").trim();
if (!prompt) {
  console.error("usage: chat-driver.mjs \"prompt\" [--new] [--confirm once|chat|deny] [--access text] [--timeout s]");
  process.exit(2);
}
if (!["once", "chat", "deny"].includes(confirmPolicy)) {
  console.error("--confirm must be once, chat or deny");
  process.exit(2);
}

const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const target = list.find((t) => t.type === "page" && t.title.includes(windowName) && t.url.includes(`/app/${windowName}`));
if (!target) {
  console.error(`No Roam window for graph ${windowName}. This driver only runs on that test graph.`);
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
const consoleLines = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === "Runtime.consoleAPICalled") {
    const text = (message.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    if (/roam-tool-hub|agent harness|agent:/.test(text)) consoleLines.push(`${message.params.type}: ${text.slice(0, 400)}`);
  }
});
function send(method, params = {}) {
  const id = (nextId += 1);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fail(message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 1));
  ws.close();
  process.exit(1);
}

await send("Runtime.enable");

const PAGE_HELPERS = `
  const q = (s, root = document) => root.querySelector(s);
  const qa = (s, root = document) => [...root.querySelectorAll(s)];
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0.05;
  const bridge = () => window.__roamToolHubChatBridge;
  const stats = () => { const s = bridge()?.status; return s ? { phase: s.phase, verified: s.verified, tools: s.tools, ...s.stats } : null; };
`;

// 1. Chat panel open, optional new chat, optional access level.
const opened = await evaluate(`(async () => { ${PAGE_HELPERS}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (location.hash.indexOf("/app/${windowName}") < 0) return { error: "wrong graph: " + location.hash };
  if (!q(".rm-agent-chat-panel")) { q(".rm-agent-sidebar-chat-launcher")?.click(); await sleep(1200); }
  if (!q(".rm-agent-chat-panel")) return { error: "chat panel did not open" };
  if (${JSON.stringify(newChat)}) { q(".rm-agent-chat-new-tab")?.click(); await sleep(700); }
  return { ok: true, version: window.__ROAM_TOOL_HUB_VERSION, stats: stats(), title: document.title };
})()`);
if (opened.error) fail(opened.error);

if (accessText) {
  const picked = await evaluate(`(async () => { ${PAGE_HELPERS}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const want = ${JSON.stringify(String(accessText).toLowerCase())};
    const current = q(".rm-agent-chat-access-picker")?.textContent.trim().toLowerCase() ?? "";
    if (current === want || current.startsWith(want)) {
      return { ok: true, access: q(".rm-agent-chat-access-picker")?.textContent.trim().slice(0, 40), unchanged: true };
    }
    const button = q(".rm-agent-chat-access-picker button, .rm-agent-chat-access-button");
    if (!button) return { error: "no access picker" };
    const findItems = () => qa(".bp3-popover .bp3-menu-item, .bp3-popover [role=menuitem], .bp3-popover button").filter(visible);
    let items = findItems();
    if (items.length === 0) { button.click(); await sleep(400); items = findItems(); }
    const item = items.find((el) => el.textContent.trim().toLowerCase().includes(want));
    if (!item) { button.click(); await sleep(200); return { error: "no access option matching " + want, options: items.map((el) => el.textContent.trim().slice(0, 40)) }; }
    item.click(); await sleep(700);
    return { ok: true, access: q(".rm-agent-chat-access-picker")?.textContent.trim().slice(0, 40) };
  })()`);
  if (picked.error) fail(picked.error, picked);
}

// 2. Focus the composer with a real click and prove focus before typing.
const box = await evaluate(`(() => { ${PAGE_HELPERS}
  const el = q(".rm-agent-native-composer .rm-block__input") || q(".rm-agent-native-composer textarea");
  if (!el) return null;
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
})()`);
if (!box) fail("composer not found");
for (const type of ["mousePressed", "mouseReleased"]) {
  await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
}
await sleep(350);
const focus = await evaluate(`(() => {
  const el = document.activeElement;
  const users = [...document.querySelectorAll(".rm-agent-chat-message-user")];
  const lastUser = users.length ? users[users.length - 1].innerText.trim() : "";
  return { tag: el?.tagName, id: el?.id ?? "", value: el?.value ?? null, inComposer: !!el?.closest?.(".rm-agent-native-composer"), lastUser };
})()`);
if (focus.tag !== "TEXTAREA" || !focus.inComposer) fail("the chat composer did not take focus; nothing was typed", { focus });
if (focus.value) {
  if (focus.lastUser && focus.value.trim() === focus.lastUser) {
    // Roam occasionally leaves the just-sent prompt in the composer textarea across turns in the same chat.
    await evaluate(`(() => { const el = document.activeElement; el.setSelectionRange(0, el.value.length); })()`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await sleep(200);
    const cleared = await evaluate(`(() => ({ value: document.activeElement?.value ?? null, inComposer: !!document.activeElement?.closest?.(".rm-agent-native-composer") }))()`);
    if (!cleared.inComposer || cleared.value) fail("could not clear already-sent prompt from composer", { cleared });
  } else {
    fail("the chat composer already holds text; not typing over it", { focus });
  }
}

const before = await evaluate(`(() => { ${PAGE_HELPERS}
  return { assistant: qa(".rm-agent-chat-message-assistant").length, user: qa(".rm-agent-chat-message-user").length, stats: stats() };
})()`);

await send("Input.insertText", { text: prompt });
await sleep(250);
const typed = await evaluate(`(() => { const el = document.activeElement; return { value: el?.value ?? null, inComposer: !!el?.closest?.(".rm-agent-native-composer") }; })()`);
if (!typed.inComposer || typed.value !== prompt) fail("typed text did not land in the composer as written", { typed });

// 3. Send.
const sent = await evaluate(`(() => { ${PAGE_HELPERS}
  const button = qa(".rm-agent-chat-send").find(visible) || q(".rm-agent-chat-send");
  if (!button || button.disabled) return { error: "send button unavailable" };
  button.click();
  return { ok: true };
})()`);
if (sent.error) fail(sent.error);

// 4. Wait for the turn to finish, answering the confirm dialog on the way.
const confirms = [];
const samples = [];
const startedAt = Date.now();
let stableSince = 0;
let lastSignature = "";
let finished = false;
while (Date.now() - startedAt < timeoutSec * 1000) {
  await sleep(700);
  const state = await evaluate(`(() => { ${PAGE_HELPERS}
    const dialog = q(".rth-confirm-backdrop");
    let confirm = null;
    if (dialog) {
      const paragraphs = qa("p", dialog).map((p) => p.textContent);
      confirm = { line: paragraphs[0] ?? "", args: q("pre", dialog)?.textContent.slice(0, 600) ?? "", buttons: qa("button", dialog).map((b) => b.textContent) };
      const want = ${JSON.stringify(confirmPolicy)};
      const dialogButtons = qa("button", dialog);
      let button;
      if (want === "deny") {
        button = dialogButtons.find((b) => b.textContent === "Deny");
      } else if (want === "once") {
        button = dialogButtons.find((b) => b.textContent === "Allow once");
      } else {
        button = dialogButtons.find((b) => b.textContent.startsWith("Allow ") && b.textContent.endsWith(" in this chat"))
          || dialogButtons.find((b) => b.textContent === "Allow once");
      }
      if (button) { button.click(); confirm.clicked = button.textContent; }
    }
    const roamApproval = qa(".rm-agent-chat-panel button").filter(visible).map((b) => b.textContent.trim()).filter((t) => /^(Allow|Approve|Reject|Deny|Accept)/i.test(t));
    const faces = qa(".rm-agent-chat-face, .rm-agent-chat-turn button").map((b) => ({ text: b.textContent.trim().slice(0, 12), visible: visible(b), disabled: !!b.disabled }));
    const assistants = qa(".rm-agent-chat-message-assistant");
    const last = assistants[assistants.length - 1];
    const works = qa(".rm-agent-chat-work");
    const work = works[works.length - 1];
    return {
      confirm,
      roamApproval,
      faces,
      assistant: assistants.length,
      user: qa(".rm-agent-chat-message-user").length,
      replyLength: last ? last.textContent.length : 0,
      work: work ? work.textContent.trim().slice(0, 160) : "",
      stopVisible: faces.some((f) => /stop/i.test(f.text) && f.visible),
      sendVisible: faces.some((f) => /send/i.test(f.text) && f.visible),
    };
  })()`);
  if (state.confirm) confirms.push(state.confirm);
  if (trace) samples.push({ t: Date.now() - startedAt, ...state, confirm: undefined });
  const signature = `${state.assistant}|${state.replyLength}|${state.work}|${state.stopVisible}`;
  if (signature !== lastSignature) {
    lastSignature = signature;
    stableSince = Date.now();
  }
  const answered = state.user > before.user && state.assistant > before.assistant && state.replyLength > 0;
  if (answered && !state.stopVisible && !state.confirm && Date.now() - stableSince > 3500) {
    finished = true;
    break;
  }
}

// 5. Read the result: reply text, tool rows, counters.
const result = await evaluate(`(async () => { ${PAGE_HELPERS}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const turns = qa(".rm-agent-chat-message-user");
  const assistants = qa(".rm-agent-chat-message-assistant");
  const last = assistants[assistants.length - 1];
  const works = qa(".rm-agent-chat-work");
  const work = works[works.length - 1];
  let toolRows = [];
  let workSummary = "";
  if (work) {
    const toggle = q(".rm-agent-chat-thinking-toggle", work);
    workSummary = toggle ? toggle.textContent.trim().slice(0, 160) : "";
    const wasOpen = work.children.length > 1 && work.textContent.length > workSummary.length + 5;
    if (toggle && !wasOpen) { toggle.click(); await sleep(500); }
    const container = q(".rm-agent-chat-thinking", work) || work;
    toolRows = qa("*", container)
      .filter((el) => el.children.length <= 3 && el !== toggle && !toggle?.contains(el))
      .map((el) => el.textContent.trim())
      .filter((t) => t && t.length < 220);
    toolRows = [...new Set(toolRows)].slice(0, 60);
    if (toggle && !wasOpen) { toggle.click(); }
  }
  const reply = last ? (q(".rm-agent-chat-reply", last) || last).innerText.trim() : "";
  return {
    userMessage: turns.length ? turns[turns.length - 1].innerText.trim().slice(0, 300) : "",
    reply: reply.slice(0, 6000),
    replyChars: reply.length,
    workSummary,
    toolRows,
    stats: stats(),
    conversations: bridge() ? [...bridge().conversations.entries()].slice(-1).map(([id, c]) => ({ id, access: c.access, loaded: [...c.loaded] })) : [],
    access: q(".rm-agent-chat-access-picker")?.textContent.trim().slice(0, 30) ?? null,
    model: q(".rm-agent-chat-model-row")?.textContent.trim().slice(0, 60) ?? null,
  };
})()`);

const delta = {};
if (before.stats && result.stats) {
  for (const key of ["turns", "preloads", "finds", "calls", "blocked", "errors"]) {
    delta[key] = (result.stats[key] ?? 0) - (before.stats[key] ?? 0);
  }
}

console.log(JSON.stringify({
  ok: finished,
  timedOut: !finished,
  seconds: Math.round((Date.now() - startedAt) / 1000),
  prompt,
  confirmPolicy,
  confirms,
  ...result,
  bridgeDelta: delta,
  console: consoleLines.slice(-20),
  ...(trace ? { samples } : {}),
}, null, 1));
ws.close();
process.exit(finished ? 0 : 1);
