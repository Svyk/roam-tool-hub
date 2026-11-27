import assert from "node:assert/strict";
import test from "node:test";

import { MAX_TOOL_DESCRIPTION_CHARS } from "../src/constants.js";
import { isToolReadOnly, readRegistrySnapshot, truncateText } from "../src/registry.js";

test("isToolReadOnly treats only readOnly: true (without isMutating: true) as read-only", () => {
  assert.equal(isToolReadOnly({ readOnly: true }), true);
  assert.equal(isToolReadOnly({ readOnly: true, isMutating: false }), true);
  assert.equal(isToolReadOnly({ readOnly: true, isMutating: true }), false);
  assert.equal(isToolReadOnly({ readOnly: false }), false);
  assert.equal(isToolReadOnly({ isMutating: false }), false);
  assert.equal(isToolReadOnly({}), false);
});

test("readRegistrySnapshot normalizes entries, skips malformed tools, deduplicates, and derives summaries", () => {
  const longDesc = "A".repeat(450);
  const registry = {
    "zeta-ext": {
      name: "Zeta Tools",
      version: "1.2.3",
      tools: [
        { name: "z_read", readOnly: true, description: longDesc, execute: () => ({ ok: true }) },
        { name: "z_read", readOnly: false, description: "duplicate ignored", execute: () => ({}) },
        { name: "z_write", description: "Mutate something.", execute: () => ({ ok: true }) },
        { name: "z_broken_no_exec", description: "missing execute" },
        null,
      ],
    },
    "alpha-ext": {
      name: "Alpha Tools",
      description: "  Custom   description\nwith lines. ",
      tools: [
        { name: "a_one", readOnly: true, description: "Read alpha.", parameters: { type: "object" }, execute: () => 1 },
      ],
    },
    "empty-ext": {
      name: "Empty",
      tools: [],
    },
    "invalid-ext": "not-an-object",
  };

  const snap = readRegistrySnapshot(() => registry);
  assert.deepEqual(snap.extensions.map((e) => e.key), ["alpha-ext", "zeta-ext"]);

  const alpha = snap.byKey.get("alpha-ext");
  assert.equal(alpha.summary, "Custom description with lines.");
  assert.equal(alpha.readCount, 1);
  assert.equal(alpha.writeCount, 0);

  const zeta = snap.byKey.get("zeta-ext");
  assert.equal(zeta.toolCount, 2);
  assert.equal(zeta.readCount, 1);
  assert.equal(zeta.writeCount, 1);
  assert.equal(zeta.version, "1.2.3");

  const zRead = snap.toolsById.get("zeta-ext/z_read");
  assert.equal(zRead.readOnly, true);
  assert.equal(zRead.description.length, 450);
  assert.equal(zRead.shortDescription.length, MAX_TOOL_DESCRIPTION_CHARS);
  assert.equal(zRead.shortDescription.endsWith("…"), true);

  assert.equal(truncateText("hello   world", 20), "hello world");
});
