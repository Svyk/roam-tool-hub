const MAX_ARGS_CHARS = 2000;

function formatArgs(args) {
  let text;
  try {
    text = JSON.stringify(args ?? {}, null, 2);
  } catch {
    text = String(args);
  }
  if (typeof text !== "string") text = String(text);
  if (text.length <= MAX_ARGS_CHARS) return text;
  return `${text.slice(0, MAX_ARGS_CHARS)}\n... (cut)`;
}

/**
 * A small Blueprint-styled dialog that asks before the built-in chat runs a writing tool.
 * One dialog shows at a time; later requests wait their turn. Nothing here sets innerHTML
 * and nothing listens for keys, so a stray Enter cannot approve a change.
 */
export function createChatConfirm({ documentRef = globalThis.document } = {}) {
  const queue = [];
  let current = null;
  let disposed = false;
  let counter = 0;

  function element(tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function settle(entry, decision) {
    if (entry.done) return;
    entry.done = true;
    entry.signal?.removeEventListener?.("abort", entry.onAbort);
    try {
      entry.backdrop?.remove();
    } catch {
      // The dialog may already be gone with the page.
    }
    if (current === entry) current = null;
    entry.resolve(decision);
  }

  function finish(entry, decision) {
    settle(entry, decision);
    showNext();
  }

  function show(entry) {
    current = entry;
    const { request } = entry;
    const extensionName = String(request.extensionName || "An extension");
    const toolName = String(request.toolName || "a tool");
    const titleId = `rth-confirm-title-${(counter += 1)}`;

    const backdrop = element("div", "rth-confirm-backdrop");
    const dialog = element("div", "bp3-dialog rth-confirm");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);

    const header = element("div", "bp3-dialog-header");
    const heading = element("h4", "bp3-heading", "Allow this change?");
    heading.id = titleId;
    header.append(heading);

    const body = element("div", "bp3-dialog-body");
    body.append(element("p", "", `${extensionName} wants to run ${toolName}.`));
    if (request.description) body.append(element("p", "", String(request.description)));
    body.append(element("pre", "", formatArgs(request.args)));

    const footer = element("div", "bp3-dialog-footer");
    const actions = element("div", "bp3-dialog-footer-actions");
    const buttons = [["Deny", "bp3-button", "deny"]];
    if (request.allowChat !== false) {
      buttons.push([`Allow ${extensionName} in this chat`, "bp3-button", "chat"]);
    }
    buttons.push(["Allow once", "bp3-button bp3-intent-primary", "once"]);
    for (const [label, className, decision] of buttons) {
      const button = element("button", className, label);
      button.setAttribute("type", "button");
      button.addEventListener("click", () => finish(entry, decision));
      actions.append(button);
    }
    footer.append(actions);

    dialog.append(header, body, footer);
    backdrop.append(dialog);
    entry.backdrop = backdrop;
    (documentRef.body ?? documentRef.documentElement).append(backdrop);
  }

  function showNext() {
    if (current || disposed) return;
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry.done) continue;
      if (entry.signal?.aborted) {
        settle(entry, "deny");
        continue;
      }
      try {
        show(entry);
      } catch {
        settle(entry, "deny");
        continue;
      }
      return;
    }
  }

  return {
    confirm(request = {}) {
      if (disposed || !documentRef?.createElement || request.signal?.aborted) {
        return Promise.resolve("deny");
      }
      return new Promise((resolve) => {
        const entry = { request, signal: request.signal, resolve, done: false, backdrop: null, onAbort: null };
        entry.onAbort = () => finish(entry, "deny");
        entry.signal?.addEventListener?.("abort", entry.onAbort, { once: true });
        queue.push(entry);
        showNext();
      });
    },

    dispose() {
      disposed = true;
      const pending = [...(current ? [current] : []), ...queue.splice(0)];
      for (const entry of pending) {
        entry.done = true;
        entry.signal?.removeEventListener?.("abort", entry.onAbort);
        try {
          entry.backdrop?.remove();
        } catch {
          // Already detached.
        }
        entry.resolve("deny");
      }
      current = null;
    },
  };
}
