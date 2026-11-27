import assert from "node:assert/strict";
import test from "node:test";

import { validateAgainstSchema } from "../src/schema-validator.js";

test("validates primitive types, union types, and integer vs number", () => {
  assert.equal(validateAgainstSchema("abc", { type: "string" }).valid, true);
  assert.equal(validateAgainstSchema(42, { type: "integer" }).valid, true);
  assert.equal(validateAgainstSchema(42.5, { type: "integer" }).valid, false);
  assert.equal(validateAgainstSchema(42.5, { type: "number" }).valid, true);
  assert.equal(validateAgainstSchema(Number.NaN, { type: "number" }).valid, false);
  assert.equal(validateAgainstSchema(true, { type: "boolean" }).valid, true);
  assert.equal(validateAgainstSchema(null, { type: ["string", "null"] }).valid, true);
  assert.equal(validateAgainstSchema("ok", { type: ["string", "null"] }).valid, true);
  assert.equal(validateAgainstSchema(123, { type: ["string", "null"] }).valid, false);
  assert.equal(validateAgainstSchema([], { type: "object" }).valid, false);
  assert.equal(validateAgainstSchema(null, { type: "object" }).valid, false);
});

test("validates required, properties, additionalProperties, and nested objects", () => {
  const schema = {
    type: "object",
    required: ["uid", "options"],
    additionalProperties: false,
    properties: {
      uid: { type: "string", minLength: 3, maxLength: 12 },
      options: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: { type: "string" },
      },
    },
  };

  assert.equal(validateAgainstSchema({ uid: "abc123", options: { limit: 10, note: "hi" } }, schema).valid, true);

  const missingReq = validateAgainstSchema({ uid: "abc" }, schema);
  assert.equal(missingReq.valid, false);
  assert.match(missingReq.errors[0], /missing required property "options"/);

  const badExtra = validateAgainstSchema({ uid: "abc", options: {}, rogue: 1 }, schema);
  assert.equal(badExtra.valid, false);
  assert.match(badExtra.errors[0], /\$\.rogue: additional property is not allowed/);

  const badNestedExtra = validateAgainstSchema({ uid: "abc", options: { note: 99 } }, schema);
  assert.equal(badNestedExtra.valid, false);
  assert.match(badNestedExtra.errors[0], /\$\.options\.note: expected string/);
});

test("validates arrays, items, minItems, maxItems, enum, and bounds", () => {
  const schema = {
    type: "object",
    properties: {
      tags: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: { type: "string", enum: ["a", "b", "c"] },
      },
      score: { type: "number", minimum: 0, maximum: 10 },
      code: { type: "string", minLength: 2, maxLength: 2 },
    },
  };

  assert.equal(validateAgainstSchema({ tags: ["a", "c"], score: 0, code: "😀x" }, schema).valid, true);
  assert.equal(validateAgainstSchema({ tags: [] }, schema).valid, false);
  assert.equal(validateAgainstSchema({ tags: ["a", "b", "c", "a"] }, schema).valid, false);
  assert.equal(validateAgainstSchema({ tags: ["z"] }, schema).valid, false);
  assert.equal(validateAgainstSchema({ score: -1 }, schema).valid, false);
  assert.equal(validateAgainstSchema({ score: 11 }, schema).valid, false);
  assert.equal(validateAgainstSchema({ code: "a" }, schema).valid, false);
  assert.equal(validateAgainstSchema({ code: "abc" }, schema).valid, false);
});

test("unknown keywords pass silently and boolean/null schemas behave as draft-07", () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    title: "Ignored title",
    properties: {
      email: { type: "string", format: "email", pattern: "^not-enforced$", xCustom: 123 },
    },
  };
  assert.equal(validateAgainstSchema({ email: "anything" }, schema).valid, true);
  assert.equal(validateAgainstSchema({ anything: 1 }, true).valid, true);
  assert.equal(validateAgainstSchema({ anything: 1 }, null).valid, true);
  assert.equal(validateAgainstSchema({ anything: 1 }, false).valid, false);
});

test("handles -0 enum equality, rejects non-plain objects like Date, respects patternProperties, and survives cyclic schemas", () => {
  assert.equal(validateAgainstSchema(-0, { enum: [0] }).valid, true);
  assert.equal(validateAgainstSchema(new Date(), { type: "object" }).valid, false);
  assert.equal(
    validateAgainstSchema(
      { x_foo: 1 },
      { type: "object", patternProperties: { "^x_": { type: "number" } }, additionalProperties: false },
    ).valid,
    true,
  );

  // Cyclic schema must not overflow the stack, while shared non-cyclic sibling refs still validate.
  const cyclic = { type: "object", properties: {} };
  cyclic.properties.child = cyclic;
  assert.equal(validateAgainstSchema({ child: { child: {} } }, cyclic).valid, true);

  const sharedProp = { type: "string", minLength: 2 };
  const siblingSchema = { type: "object", properties: { a: sharedProp, b: sharedProp } };
  assert.equal(validateAgainstSchema({ a: "ok", b: "x" }, siblingSchema).valid, false);
});
