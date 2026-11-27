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

function pullGuidelinesPage(roamAlphaAPI) {
  const pull = roamAlphaAPI?.data?.pull || roamAlphaAPI?.pull;
  if (typeof pull !== "function") return null;
  try {
    return pull.call(roamAlphaAPI.data || roamAlphaAPI, PAGE_PULL_PATTERN, [
      ":node/title",
      GUIDELINES_PAGE_TITLE,
    ]);
  } catch {
    return null;
  }
}

async function withGuidelinesLock(roamAlphaAPI, fn) {
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request !== "function") {
    return await fn();
  }
  const graphName = roamAlphaAPI?.graph?.name || "default";
  const lockName = `roam-tool-hub:guidelines:${graphName}`;
  return await locks.request(lockName, { ifAvailable: true }, async (lock) => {
    if (!lock) return { status: "skipped-locked", writes: 0 };
    return await fn();
  });
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
      return `**${ext.name}** (\`${ext.key}\`) — ${ext.toolCount} ${plural} (${ext.readCount} read, ${ext.writeCount} write, ${writeState}): ${ext.summary}`;
    });
    return { heading: GUIDELINES_HEADING, children };
  }

  const groups = new Map();
  let totalTools = 0;
  for (const ext of extensions) {
    const groupName = ext.group || "Other";
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
} = {}) {
  const enabled = forceEnabled !== undefined ? Boolean(forceEnabled) : isGuidelinesIndexEnabled(extensionAPI);
  if (!enabled) {
    return { status: "disabled", writes: 0 };
  }
  if (!roamAlphaAPI?.data?.block || !roamAlphaAPI?.data?.page) {
    return { status: "no-roam-api", writes: 0 };
  }

  return await withGuidelinesLock(roamAlphaAPI, async () => {
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
      pageUid = generateUid(roamAlphaAPI);
      await roamAlphaAPI.data.page.create({
        page: { title: GUIDELINES_PAGE_TITLE, uid: pageUid },
      });
      writes += 1;
      page = pullGuidelinesPage(roamAlphaAPI);
      pageUid = page?.[":block/uid"] || pageUid;
    }

    const storedUid = getGuidelinesBlockUid(extensionAPI);
    const topLevelBlocks = sortByOrder(page?.[":block/children"]);
    const existingBlock = storedUid
      ? topLevelBlocks.find((child) => child?.[":block/uid"] === storedUid) || null
      : null;

    if (!existingBlock) {
      const parentUid = generateUid(roamAlphaAPI);
      await roamAlphaAPI.data.block.create({
        location: { "parent-uid": pageUid, order: "last" },
        block: { uid: parentUid, string: model.heading },
      });
      writes += 1;
      for (let i = 0; i < model.children.length; i += 1) {
        await roamAlphaAPI.data.block.create({
          location: { "parent-uid": parentUid, order: i },
          block: { uid: generateUid(roamAlphaAPI), string: model.children[i] },
        });
        writes += 1;
      }
      await setGuidelinesBlockUid(extensionAPI, parentUid);
      return { status: "created", uid: parentUid, writes };
    }

    const existingChildren = sortByOrder(existingBlock[":block/children"]);
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
  if (!roamAlphaAPI?.data?.block) {
    return { status: "no-roam-api", deleted: false };
  }
  return await withGuidelinesLock(roamAlphaAPI, async () => {
    const storedUid = getGuidelinesBlockUid(extensionAPI);
    if (!storedUid) {
      return { status: "not-found", deleted: false };
    }

    const page = pullGuidelinesPage(roamAlphaAPI);
    const topLevelBlocks = sortByOrder(page?.[":block/children"]);
    const ownedBlock = topLevelBlocks.find((child) => child?.[":block/uid"] === storedUid) || null;

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
