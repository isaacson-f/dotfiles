import assert from "node:assert/strict";
import test from "node:test";
import { parseModelJson } from "../model-json.ts";

test("bare, fenced, and prose-wrapped JSON answers decode to the same value", () => {
  const plan = { remove: [], merge: [] };
  assert.deepEqual(parseModelJson('{"remove":[],"merge":[]}'), plan);
  assert.deepEqual(parseModelJson('```json\n{"remove":[],"merge":[]}\n```'), plan);
  // Observed Claude Haiku cleanup answer: a fenced plan followed by an explanation paragraph.
  assert.deepEqual(parseModelJson('```json\n{"remove":[],"merge":[]}\n```\n\nThe single entry is durable, so no changes are needed.'), plan);
  assert.deepEqual(parseModelJson('Here is the plan: {"remove":[],"merge":[]} — nothing to change.'), plan);
  assert.deepEqual(parseModelJson('[{"name":"a"}]\nDone.'), [{ name: "a" }]);
});

test("answers without a JSON value fail with SyntaxError", () => {
  for (const raw of ["", "Nothing to change.", '```json\n{"remove":[\n```']) {
    assert.throws(() => parseModelJson(raw), SyntaxError);
  }
});
