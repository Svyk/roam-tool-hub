import {
  GUIDELINES_PAGE_TITLE,
  GUIDELINES_SUMMARY_THRESHOLD,
} from "./constants.js";
import { defaultRegistryGetter, readRegistrySnapshot } from "./registry.js";
import {
  getGuidelinesBlockUid,
  isExtensionEnabled,
  isExtensionWriteEnabled,
  isGuidelinesIndexEnabled,
  setGuidelinesBlockUid,
} from "./settings.js";

export const GUIDELINES_HEADING =
  "**Tool Hub** (generated index — managed by Tool Hub; edit settings instead of this block)";

const PAGE_PULL_PATTERN =
  "[:block/uid :node/title {:block/children [:block/uid :block/string :block/order {:block/children [:block/uid :block/string :block/order]}]}]";

const BLOCK_PULL_PATTERN =
  "[:block/uid :block/string {:block/page [:node/title :block/uid]} {:block/children [:block/uid :block/string :block/order]}]";

function sortByOrder(children) {
  if (!Array.isArray(children)) return [];
  return [...children].sort((a, b) => (a?.[":block/order"] ?? 0) - (b?.[":block/order"] ?? 0));
}

function defaultRoamApiGetter() {
  if (typeof globalThis.window !== "undefined" && globalThis.window.roamAlphaAPI) {
    return globalThis.window.roamAlphaAPI;
  }
  return globalThis.roamAlphaAPI || null;
}

function generateUid(roamAlphaAPI) {
  if (typeof roamAlphaAPI?.util?.generateUID === "function") {
    return roamAlphaAPI.util.generateUID();
  }
  return `rth${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Neutralizes live Roam syntax (macros {{}}, page refs [[]], block refs (()),
 * #tags, and Attr:: attributes) so generated summary text never mounts widgets
 * or creates unintended graph references on roam/agent guidelines.
 */
export function sanitizeRoamMarkup(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean
    .replace(/\{\{/g, "{ {")
    .replace(/\}\}/g, "} }")
    .replace(/\[\[/g, "[ [")
    .replace(/\]\]/g, "] ]")
    .replace(/\(\(/g, "( (")
    .replace(/\)\)/g, ") )")
    .replace(/::/g, ":")
    .replace(/(^|[\s(])#([A-Za-z0-9_/-]+)/g, "$1`#$2`");
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

function pullGuidelinesPage(roamAlphaAPI) {
  return pullWithReceiver(roamAlphaAPI, PAGE_PULL_PATTERN, [
    ":node/title",
    GUIDELINES_PAGE_TITLE,
  ]);
}

function findOwnedBlockOnGuidelinesPage(roamAlphaAPI, page, storedUid) {
  if (!storedUid) return null;
  const direct = pullWithReceiver(roamAlphaAPI, BLOCK_PULL_PATTERN, [":block/uid", storedUid]);
  if (direct?.[":block/uid"] === storedUid) {
    const pageRef = Array.isArray(direct[":block/page"]) ? direct[":block/page"][0] : direct[":block/page"];
    const pageTitle = pageRef?.[":node/title"];
    const pageUid = pageRef?.[":block/uid"];
    if (
      pageTitle === GUIDELINES_PAGE_TITLE
      || (page?.[":block/uid"] && pageUid === page[":block/uid"])
    ) {
      return direct;
    }
  }
  const topLevel = sortByOrder(page?.[":block/children"]);
  return topLevel.find((child) => child?.[":block/uid"] === storedUid) || null;
}

async function withGuidelinesLock(roamAlphaAPI, fn) {
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request !== "function") {
    return await fn();
  }
  const graphName = roamAlphaAPI?.graph?.name || "default";
  const lockName = `roam-tool-hub:guidelines:${graphName}`;
  return await locks.request(lockName, async () => await fn());
}

export function buildGuidelinesIndexModel({ extensions = [], isWriteEnabled = () => false } = {}) {
  if (extensions.length === 0) {
    return {
      heading: GUIDELINES_HEADING,
      children: [
        "No extensions currently enabled in Tool Hub. Call list_extensions to check live tools.",
      ],
    };
  }

  if (extensions.length <= GUIDELINES_SUMMARY_THRESHOLD) {
    const children = extensions.map((ext) => {
      const plural = ext.toolCount === 1 ? "tool" : "tools";
      const writeState = isWriteEnabled(ext.key) ? "writes on" : "writes off";
      const safeName = sanitizeRoamMarkup(ext.name);
      const safeKey = sanitizeRoamMarkup(ext.key);
      const safeSummary = sanitizeRoamMarkup(ext.summary);
      return `**${safeName}** (\`${safeKey}\`) — ${ext.toolCount} ${plural} (${ext.readCount} read, ${ext.writeCount} write, ${writeState}): ${safeSummary}`;
    });
    return { heading: GUIDELINES_HEADING, children };
  }

  const groups = new Map();
  let totalTools = 0;
  for (const ext of extensions) {
    const groupName = sanitizeRoamMarkup(ext.group || "Other") || "Other";
    if (!groups.has(groupName)) groups.set(groupName, { count: 0, tools: 0 });
    const bucket = groups.get(groupName);
    bucket.count += 1;
    bucket.tools += ext.toolCount;
    totalTools += ext.toolCount;
  }

  const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
    if (a === "Other" && b !== "Other") return 1;
    if (b === "Other" && a !== "Other") return -1;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });

  const children = sortedGroups.map(([groupName, stats]) => {
    const extWord = stats.count === 1 ? "extension" : "extensions";
    const toolWord = stats.tools === 1 ? "tool" : "tools";
    return `${groupName}: ${stats.count} ${extWord} (${stats.tools} ${toolWord})`;
  });
  children.push(
    `Total: ${extensions.length} enabled extensions (${totalTools} tools). Call list_extensions to browse them.`,
  );
  return { heading: GUIDELINES_HEADING, children };
}

export async function syncGuidelinesIndex({
  extensionAPI,
  roamAlphaAPI = defaultRoamApiGetter(),
  getRegistry = defaultRegistryGetter,
  forceEnabled,
  allowShrink = true,
} = {}) {
  const enabled = forceEnabled !== undefined ? Boolean(forceEnabled) : isGuidelinesIndexEnabled(extensionAPI);
  if (!enabled) {
    return { status: "disabled", writes: 0 };
  }
  if (extensionAPI?.settings?.canSet === false) {
    return { status: "read-only-settings", writes: 0 };
  }
  if (!roamAlphaAPI?.data?.block || !roamAlphaAPI?.data?.page) {
    return { status: "no-roam-api", writes: 0 };
  }

  return await withGuidelinesLock(roamAlphaAPI, async () => {
    // Re-check enabled inside the lock unless explicitly forced, so a queued OFF wins.
    if (forceEnabled === undefined && !isGuidelinesIndexEnabled(extensionAPI)) {
      return { status: "disabled", writes: 0 };
    }

    const snapshot = readRegistrySnapshot(getRegistry);
    const enabledExts = snapshot.extensions.filter((ext) => isExtensionEnabled(extensionAPI, ext.key));
    const model = buildGuidelinesIndexModel({
      extensions: enabledExts,
      isWriteEnabled: (key) => isExtensionWriteEnabled(extensionAPI, key),
    });

    let page = pullGuidelinesPage(roamAlphaAPI);
    let pageUid = page?.[":block/uid"] || null;
    let writes = 0;

    if (!pageUid) {
      const candidateUid = generateUid(roamAlphaAPI);
      try {
        await roamAlphaAPI.data.page.create({
          page: { title: GUIDELINES_PAGE_TITLE, uid: candidateUid },
        });
        writes += 1;
      } catch {
        // Another tab may have created the page concurrently; re-pull below.
      }
      page = pullGuidelinesPage(roamAlphaAPI);
      pageUid = page?.[":block/uid"] || candidateUid;
    }

    const storedUid = getGuidelinesBlockUid(extensionAPI);
    const existingBlock = findOwnedBlockOnGuidelinesPage(roamAlphaAPI, page, storedUid);

    if (!existingBlock) {
      if (!allowShrink && enabledExts.length === 0) {
        return { status: "deferred-empty-boot", writes: 0 };
      }
      const parentUid = generateUid(roamAlphaAPI);
      await roamAlphaAPI.data.block.create({
        location: { "parent-uid": pageUid, order: "last" },
        block: { uid: parentUid, string: model.heading },
      });
      writes += 1;
      // Persist immediately after creating parent so a mid-loop failure never orphans it.
      await setGuidelinesBlockUid(extensionAPI, parentUid);
      for (let i = 0; i < model.children.length; i += 1) {
        await roamAlphaAPI.data.block.create({
          location: { "parent-uid": parentUid, order: i },
          block: { uid: generateUid(roamAlphaAPI), string: model.children[i] },
        });
        writes += 1;
      }
      return { status: "created", uid: parentUid, writes };
    }

    const existingChildren = sortByOrder(existingBlock[":block/children"]);
    // On boot (allowShrink: false), never shrink an already-populated index because
    // other extensions may not have finished registering on window.RoamExtensionTools yet.
    if (!allowShrink && (enabledExts.length === 0 || model.children.length < existingChildren.length)) {
      return { status: "preserved-on-boot", uid: storedUid, writes: 0 };
    }

    const headingMatches = existingBlock[":block/string"] === model.heading;
    const childrenMatch =
      existingChildren.length === model.children.length
      && existingChildren.every((child, index) => child?.[":block/string"] === model.children[index]);

    if (headingMatches && childrenMatch) {
      return { status: "unchanged", uid: storedUid, writes: 0 };
    }

    if (!headingMatches) {
      await roamAlphaAPI.data.block.update({
        block: { uid: storedUid, string: model.heading },
      });
      writes += 1;
    }

    const sharedCount = Math.min(existingChildren.length, model.children.length);
    for (let i = 0; i < sharedCount; i += 1) {
      if (existingChildren[i]?.[":block/string"] !== model.children[i]) {
        await roamAlphaAPI.data.block.update({
          block: { uid: existingChildren[i][":block/uid"], string: model.children[i] },
        });
        writes += 1;
      }
    }

    for (let i = existingChildren.length; i < model.children.length; i += 1) {
      await roamAlphaAPI.data.block.create({
        location: { "parent-uid": storedUid, order: i },
        block: { uid: generateUid(roamAlphaAPI), string: model.children[i] },
      });
      writes += 1;
    }

    for (let i = existingChildren.length - 1; i >= model.children.length; i -= 1) {
      await roamAlphaAPI.data.block.delete({
        block: { uid: existingChildren[i][":block/uid"] },
      });
      writes += 1;
    }

    return { status: "updated", uid: storedUid, writes };
  });
}

export async function removeGuidelinesIndex({
  extensionAPI,
  roamAlphaAPI = defaultRoamApiGetter(),
} = {}) {
  if (extensionAPI?.settings?.canSet === false) {
    return { status: "read-only-settings", deleted: false };
  }
  if (!roamAlphaAPI?.data?.block) {
    return { status: "no-roam-api", deleted: false };
  }
  return await withGuidelinesLock(roamAlphaAPI, async () => {
    const storedUid = getGuidelinesBlockUid(extensionAPI);
    if (!storedUid) {
      return { status: "not-found", deleted: false };
    }

    const page = pullGuidelinesPage(roamAlphaAPI);
    const ownedBlock = findOwnedBlockOnGuidelinesPage(roamAlphaAPI, page, storedUid);

    if (ownedBlock) {
      await roamAlphaAPI.data.block.delete({
        block: { uid: storedUid },
      });
    }
    await setGuidelinesBlockUid(extensionAPI, null);
    return {
      status: ownedBlock ? "removed" : "cleared-stale-uid",
      uid: storedUid,
      deleted: Boolean(ownedBlock),
    };
  });
}
