import assert from "node:assert/strict";
import test from "node:test";
import { buildInjectedContext, searchMemory } from "../store.ts";
import type { MemorySnapshot } from "../store.ts";

const snapshot: MemorySnapshot = {
  identity: { scope: "repo/example", directory: "example-123" },
  user: ["Prefer concise answers.", "Chrome initialization may list pages and create a new tab without repeated confirmation."],
  global: ["Run focused tests before production changes."],
  repository: ["The deploy runbook lives in docs/deploy.md."],
  text: "",
};

const contents = (result: ReturnType<typeof searchMemory>) => result.results.map(entry => entry.content);

// This fails if retrieval still requires every query word or adds an exact-phrase bonus instead of scoring OR matches by BM25.
test("search ranks rare query terms above common-only documents and returns partial matches", () => {
  const corpus: MemorySnapshot = {
    ...snapshot,
    user: ["common common common common", "common orchid", "common handbook", "orchid handbook"],
    global: [], repository: [], text: "",
  };
  const result = searchMemory(corpus, { query: "common orchid missing", scopes: ["user"], limit: 5, maxChars: 1_000 });
  assert.equal(result.code, "ok");
  assert.deepEqual(contents(result), ["common orchid", "orchid handbook", "common common common common", "common handbook"]);
});

// This fails if raw term occurrence counts outrank BM25's saturated, length-normalized term frequency.
test("search saturates term frequency and normalizes document length", () => {
  const long = `signal signal signal ${"filler ".repeat(97)}`;
  const corpus: MemorySnapshot = { ...snapshot, user: [long, "signal signal"], global: [], repository: [], text: "" };
  const result = searchMemory(corpus, { query: "signal", scopes: ["user"], limit: 2, maxChars: 2_000 });
  assert.equal(result.code, "ok");
  assert.deepEqual(contents(result), ["signal signal", long]);
});

// This fails if search uses substring matching, locale-sensitive normalization, or treats punctuation as part of a word.
test("search tokenizes Unicode letters and numbers at punctuation boundaries with case-insensitive matching", () => {
  const corpus: MemorySnapshot = { ...snapshot, user: ["alphabet beta", "ALPHA—beta café 42"], global: [], repository: [], text: "" };
  const boundary = searchMemory(corpus, { query: "alpha", scopes: ["user"], limit: 5, maxChars: 1_000 });
  assert.equal(boundary.code, "ok");
  assert.deepEqual(contents(boundary), ["ALPHA—beta café 42"]);
  const punctuation = searchMemory(corpus, { query: "BETA! CAFÉ, 42", scopes: ["user"], limit: 5, maxChars: 1_000 });
  assert.equal(punctuation.results[0]?.content, "ALPHA—beta café 42");
});

// This fails if ties depend on locale sorting or duplicate query/scope selectors duplicate documents or alter the allowed corpus.
test("search preserves stored order for ties and de-duplicates query tokens and scopes", () => {
  const tied: MemorySnapshot = { ...snapshot, user: ["alpha first", "alpha second"], global: ["alpha global"], repository: [], text: "" };
  const single = searchMemory(tied, { query: "alpha", scopes: ["user", "global"], limit: 5, maxChars: 1_000 });
  const duplicate = searchMemory(tied, { query: "alpha alpha", scopes: ["user", "user", "global", "global"], limit: 5, maxChars: 1_000 });
  assert.equal(single.code, "ok");
  assert.deepEqual(contents(single), ["alpha first", "alpha second", "alpha global"]);
  assert.deepEqual(duplicate, single);
});

// This fails if corpus construction leaks unselected scope entries into the result set or corpus statistics.
test("search builds its corpus only from permitted scopes", () => {
  const isolated: MemorySnapshot = { ...snapshot, user: ["common user"], global: ["rare global"], repository: [], text: "" };
  assert.equal(searchMemory(isolated, { query: "rare", scopes: ["user"], maxChars: 1_000 }).code, "no_results");
  assert.deepEqual(contents(searchMemory(isolated, { query: "rare", scopes: ["global"], maxChars: 1_000 })), ["rare global"]);
});

test("search rejects invalid queries and scope sets without reading another repository", () => {
  assert.equal(searchMemory(snapshot, { query: " ", scopes: ["user"], limit: 5, maxChars: 1_000 }).code, "invalid_query");
  assert.equal(searchMemory(snapshot, { query: "chrome", scopes: [], limit: 5, maxChars: 1_000 }).code, "invalid_scope");
});

test("retrieval-first injection contains only explicitly pinned entries and search guidance", () => {
  const text = buildInjectedContext(snapshot, {
    mode: "retrieval-first",
    maxChars: 800,
    pins: { user: ["Prefer concise answers."], global: [], repository: [] },
  });
  assert.match(text, /Prefer concise answers/);
  assert.doesNotMatch(text, /Chrome initialization/);
  assert.doesNotMatch(text, /focused tests/);
  assert.match(text, /Search memory when durable context may be relevant/);
  assert.match(text, /untrusted reference data/);
});
