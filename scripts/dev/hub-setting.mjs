#!/usr/bin/env node
// Flips one Tool Hub settings switch in Roam Desktop's Readwisenotes window, by label prefix.
//
//   node hub-setting.mjs "Roam Grid — expose tools" off
//   node hub-setting.mjs "Built-in chat bridge" on
//   node hub-setting.mjs --list
//
// Opens Tool Hub's own settings tab through roamAlphaAPI.depot.openSettings, clicks the switch
// only when its state differs, closes the dialog, and prints the bridge status afterwards.

const [labelPrefix, wanted] = process.argv.slice(2);
if (!labelPrefix || (labelPrefix !== "--list" && !["on", "off"].includes(wanted))) {
  console.error('usage: hub-setting.mjs "<label prefix>" on|off   |   hub-setting.mjs --list');
  process.exit(2);
}
const WINDOW = "Readwisenotes";
const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const target = list.find((t) => t.type === "page" && t.title.includes(WINDOW) && t.url.includes(`/app/${WINDOW}`));
if (!target) {
  console.error(`No Roam window for graph ${WINDOW}.`);
  process.exit(2);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
const expression = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  if (!document.querySelector(".rm-settings")) {
    await window.roamAlphaAPI.depot.openSettings({ id: "https://svyk.github.io/roam-tool-hub/" });
    await sleep(900);
  }
  // Only Tool Hub's own panel: Roam keeps every settings tab in the DOM.
  const anchor = [...document.querySelectorAll(".rm-settings h4")].find((h) => h.textContent.trim() === "Refresh discovered extensions");
  const panel = anchor?.closest("section")?.parentElement;
  if (!panel) {
    document.querySelector(".rm-settings .rm-settings-close-button")?.click();
    return JSON.stringify({ error: "Tool Hub's settings panel was not found; nothing was clicked" });
  }
  const rows = [...panel.querySelectorAll("h4")].map((h) => {
    // A switch belongs to the same <section> as its label, never to a neighbour.
    const input = h.closest("section")?.querySelector('input[type="checkbox"]') ?? null;
    return { label: h.textContent.trim(), input };
  }).filter((r) => r.input);
  const prefix = ${JSON.stringify(labelPrefix)};
  if (prefix === "--list") {
    out.switches = rows.map((r) => ({ label: r.label, on: r.input.checked }));
  } else {
    const row = rows.find((r) => r.label.startsWith(prefix));
    if (!row) {
      out.error = "no switch whose label starts with: " + prefix;
      out.labels = rows.map((r) => r.label);
    } else {
      const want = ${JSON.stringify(wanted === "on")};
      out.label = row.label; out.was = row.input.checked;
      if (row.input.checked !== want) { row.input.click(); await sleep(1500); }
      const again = [...panel.querySelectorAll("h4")].find((h) => h.textContent.trim() === row.label);
      const i2 = again?.closest("section")?.querySelector('input[type="checkbox"]') ?? null;
      out.now = i2 ? i2.checked : null;
    }
  }
  document.querySelector(".rm-settings .rm-settings-close-button")?.click();
  await sleep(400);
  const s = window.__roamToolHubChatBridge?.status;
  out.bridge = s ? { phase: s.phase, detail: s.detail, tools: s.tools, extensions: s.extensions, verified: s.verified } : null;
  out.settingsStillOpen = !!document.querySelector(".rm-settings");
  return JSON.stringify(out, null, 1);
})()`;
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== 1) return;
  if (message.result.exceptionDetails) {
    console.error(JSON.stringify(message.result.exceptionDetails).slice(0, 800));
    process.exit(1);
  }
  console.log(message.result.result.value);
  ws.close();
  process.exit(0);
});
