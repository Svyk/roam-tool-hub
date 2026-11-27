import {
  INBOX_CALL_PREFIX,
  INBOX_PAGE_TITLE,
  INBOX_RESULT_PREFIX,
  LOG_PREFIX,
  MAX_INBOX_HISTORY,
  MAX_INBOX_RESULT_CHARS,
} from "./constants.js";
import { HUB_TOOL_NAMES } from "./hub-tools.js";
import { safeSlice } from "./registry.js";
import { isPlainObject } from "./schema-validator.js";

const VALID_ACTIONS = new Set(HUB_TOOL_NAMES);

const INBOX_WATCH_PATTERN =
  "[:block/uid {:block/children [:block/uid :block/string :block/order {:create/user [:user/uid]} {:block/children [:block/uid :block/string]}]}]";

const REQUEST_PULL_PATTERN =
  "[:block/uid :block/string {:create/user [:user/uid]} {:block/children [:block/uid]}]";

function defaultRoamApiGetter() {
  if (typeof globalThis.window !== "undefined" && globalThis.window.roamAlphaAPI) {
    return globalThis.window.roamAlphaAPI;
  }
  return globalThis.roamAlphaAPI || null;
}

function pullWithReceiver(roamAlphaAPI, pattern, entity) {
  const pull = roamAlphaAPI?.data?.pull || roamAlphaAPI?.pull;
  if (typeof pull !== "function") return null;
  try {
    return pull.call(roamAlphaAPI.data || roamAlphaAPI, pattern, entity);
  } catch {
    return null;
  }
}

function generateUid(roamAlphaAPI) {
  if (typeof roamAlphaAPI?.util?.generateUID === "function") {
    return roamAlphaAPI.util.generateUID();
  }
  return `rth${Math.random().toString(36).slice(2, 10)}`;
}

function unwrapBackticks(text) {
  let s = String(text ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fenced) return fenced[1].trim();
  if (s.startsWith("`") && s.endsWith("`") && s.length >= 2) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function parseInboxCall(blockString) {
  const unwrapped = unwrapBackticks(blockString);
  const prefixMatch = /^rth-call(?:\s+([\s\S]*))?$/i.exec(unwrapped);
  if (!prefixMatch) return { matched: false };

  const rawBody = unwrapBackticks(prefixMatch[1] ?? "");
  if (!rawBody) {
    return {
      matched: true,
      error: `Missing JSON payload after "${INBOX_CALL_PREFIX}". Example: ${INBOX_CALL_PREFIX} {"action":"list_extensions"}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    return {
      matched: true,
      error: `Invalid JSON in ${INBOX_CALL_PREFIX}: ${error?.message || String(error)}`,
    };
  }

  if (!isPlainObject(parsed)) {
    return { matched: true, error: `${INBOX_CALL_PREFIX} payload must be a JSON object.` };
  }

  let action = typeof parsed.action === "string" ? parsed.action.trim() : "";
  if (!action && typeof parsed.tool === "string" && parsed.tool.trim()) {
    action = "run_tool";
  }
  if (!VALID_ACTIONS.has(action)) {
    return {
      matched: true,
      error: `Invalid action "${action}". Must be one of: ${HUB_TOOL_NAMES.join(", ")}.`,
    };
  }

  const restKeys = Object.keys(parsed).filter((k) => k !== "action");
  let args;
  if (restKeys.length === 1 && restKeys[0] === "args" && isPlainObject(parsed.args)) {
    args = parsed.args;
  } else {
    args = {};
    for (const k of restKeys) {
      args[k] = parsed[k];
    }
  }

  return { matched: true, action, args };
}

export function serializeInboxResult(payload, maxChars = MAX_INBOX_RESULT_CHARS) {
  let json;
  try {
    json = JSON.stringify(payload === undefined ? null : payload);
  } catch (error) {
    json = JSON.stringify({
      code: "serialization-error",
      error: `Result was not JSON-serializable: ${error?.message || String(error)}`,
    });
  }
  if (json.length <= maxChars) {
    return `${INBOX_RESULT_PREFIX} ${json}`;
  }
  const previewBudget = Math.max(256, maxChars - 240);
  const preview = safeSlice(json, previewBudget);
  const wrapped = JSON.stringify({
    truncated: true,
    originalChars: json.length,
    maxChars,
    note: `Inbox result truncated from ${json.length} to ${preview.length} characters.`,
    resultPreview: preview,
  });
  return `${INBOX_RESULT_PREFIX} ${wrapped}`;
}

async function withInboxItemLock(roamAlphaAPI, blockUid, fn) {
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request !== "function") {
    return await fn();
  }
  const graphName = roamAlphaAPI?.graph?.name || "default";
  const lockName = `roam-tool-hub:inbox:${graphName}:${blockUid}`;
  return await locks.request(lockName, { ifAvailable: true }, async (lock) => {
    if (!lock) return { skipped: "locked" };
    return await fn();
  });
}

function extractUserUid(block) {
  const user = block?.[":create/user"];
  const obj = Array.isArray(user) ? user[0] : user;
  const uid = obj?.[":user/uid"];
  return typeof uid === "string" && uid.trim() ? uid.trim() : undefined;
}

export function createInboxBridge({
  roamAlphaAPI = defaultRoamApiGetter(),
  tools = [],
  maxHistory = MAX_INBOX_HISTORY,
  maxResultChars = MAX_INBOX_RESULT_CHARS,
} = {}) {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const seenUids = new Set();
  let active = false;
  let disposed = false;
  let inboxPageUid = null;
  let watchEntity = null;
  let watchCallback = null;
  let startPromise = null;

  const getRoam = () => roamAlphaAPI || defaultRoamApiGetter();

  async function ensureInboxPage(roam) {
    let page = pullWithReceiver(roam, "[:block/uid :node/title {:block/children [:block/uid]}]", [
      ":node/title",
      INBOX_PAGE_TITLE,
    ]);
    if (page?.[":block/uid"]) return page;

    const uid = generateUid(roam);
    try {
      await roam.data.page.create({ page: { title: INBOX_PAGE_TITLE, uid } });
    } catch {
      // Another tab may have created the inbox page concurrently.
    }
    page = pullWithReceiver(roam, "[:block/uid :node/title {:block/children [:block/uid]}]", [
      ":node/title",
      INBOX_PAGE_TITLE,
    ]);
    return page?.[":block/uid"] ? page : { ":block/uid": uid, ":block/children": [] };
  }

  async function pruneCompletedHistory(roam, pageUid) {
    if (!pageUid || maxHistory <= 0) return;
    const page = pullWithReceiver(roam, INBOX_WATCH_PATTERN, [":block/uid", pageUid]);
    const children = Array.isArray(page?.[":block/children"]) ? [...page[":block/children"]] : [];
    const completedCalls = children
      .filter((child) => {
        const str = child?.[":block/string"] || "";
        const sub = child?.[":block/children"];
        return parseInboxCall(str).matched && Array.isArray(sub) && sub.length > 0;
      })
      .sort((a, b) => (a?.[":block/order"] ?? 0) - (b?.[":block/order"] ?? 0));

    if (completedCalls.length <= maxHistory) return;
    const toDelete = completedCalls.slice(0, completedCalls.length - maxHistory);
    for (const old of toDelete) {
      if (disposed || !active) break;
      try {
        await roam.data.block.delete({ block: { uid: old[":block/uid"] } });
      } catch {
        // Best-effort pruning; ignore already-deleted blocks.
      }
    }
  }

  async function processBlock(block) {
    if (disposed || !active) return;
    const uid = block?.[":block/uid"];
    if (typeof uid !== "string" || !uid || seenUids.has(uid)) return;

    const existingChildren = block?.[":block/children"];
    if (Array.isArray(existingChildren) && existingChildren.length > 0) {
      seenUids.add(uid);
      return;
    }

    const parsed = parseInboxCall(block?.[":block/string"] ?? "");
    if (!parsed.matched) return;

    seenUids.add(uid);
    const roam = getRoam();
    if (!roam?.data?.block?.create) return;

    await withInboxItemLock(roam, uid, async () => {
      if (disposed || !active) return;
      const fresh = pullWithReceiver(roam, REQUEST_PULL_PATTERN, [":block/uid", uid]);
      if (!fresh?.[":block/uid"]) return;
      if (Array.isArray(fresh[":block/children"]) && fresh[":block/children"].length > 0) return;

      const freshParsed = parseInboxCall(fresh[":block/string"] ?? "");
      if (!freshParsed.matched) return;

      let output;
      if (freshParsed.error) {
        output = { code: "invalid-request", error: freshParsed.error };
      } else {
        const tool = toolsByName.get(freshParsed.action);
        if (!tool) {
          output = { code: "unknown-action", error: `Unknown Tool Hub action "${freshParsed.action}".` };
        } else {
          const tokenUserUid = extractUserUid(fresh) || extractUserUid(block);
          const context = tokenUserUid ? { tokenUserUid } : {};
          try {
            output = await tool.handler(freshParsed.args, context);
          } catch (error) {
            output = {
              code: "execution-error",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
      }

      if (disposed) return;
      const resultString = serializeInboxResult(output, maxResultChars);
      try {
        await roam.data.block.create({
          location: { "parent-uid": uid, order: 0 },
          block: { uid: generateUid(roam), string: resultString },
        });
      } catch (error) {
        console.warn(`${LOG_PREFIX} Failed writing inbox result for ${uid}`, error);
        return;
      }

      await pruneCompletedHistory(roam, inboxPageUid);
    });
  }

  function handleWatchUpdate(_before, after) {
    if (disposed || !active) return;
    const children = after?.[":block/children"];
    if (!Array.isArray(children)) return;
    for (const child of children) {
      void processBlock(child).catch((error) => {
        console.warn(`${LOG_PREFIX} Inbox bridge error`, error);
      });
    }
  }

  async function start() {
    if (disposed) return { active: false, pageUid: null };
    if (active && inboxPageUid) return { active: true, pageUid: inboxPageUid };
    if (startPromise) return startPromise;

    startPromise = (async () => {
      const roam = getRoam();
      if (
        !roam?.data?.addPullWatch
        || !roam?.data?.removePullWatch
        || !roam?.data?.page?.create
        || !roam?.data?.block?.create
      ) {
        return { active: false, pageUid: null };
      }

      const page = await ensureInboxPage(roam);
      if (disposed) return { active: false, pageUid: null };

      const pageUid = page?.[":block/uid"];
      if (!pageUid) return { active: false, pageUid: null };

      // Snapshot all pre-existing children so reload/enable never replays old requests.
      for (const child of page?.[":block/children"] || []) {
        if (child?.[":block/uid"]) seenUids.add(child[":block/uid"]);
      }

      const entityStr = `[:block/uid "${pageUid}"]`;
      const cb = (before, after) => handleWatchUpdate(before, after);
      active = true;
      inboxPageUid = pageUid;
      watchEntity = entityStr;
      watchCallback = cb;

      await roam.data.addPullWatch(INBOX_WATCH_PATTERN, entityStr, cb);
      if (disposed || !active) {
        try {
          await roam.data.removePullWatch(INBOX_WATCH_PATTERN, entityStr, cb);
        } catch {
          // Best-effort teardown.
        }
        return { active: false, pageUid: null };
      }
      return { active: true, pageUid };
    })().finally(() => {
      startPromise = null;
    });

    return startPromise;
  }

  async function stop() {
    if (!active && !watchCallback) return;
    active = false;
    const entity = watchEntity;
    const cb = watchCallback;
    watchEntity = null;
    watchCallback = null;
    const roam = getRoam();
    if (entity && cb && typeof roam?.data?.removePullWatch === "function") {
      try {
        await roam.data.removePullWatch(INBOX_WATCH_PATTERN, entity, cb);
      } catch (error) {
        console.warn(`${LOG_PREFIX} Failed removing inbox pull watch`, error);
      }
    }
  }

  async function dispose() {
    disposed = true;
    await stop();
  }

  return {
    start,
    stop,
    dispose,
    processBlock,
    get active() {
      return active;
    },
    get pageUid() {
      return inboxPageUid;
    },
  };
}
