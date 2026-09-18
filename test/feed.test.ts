import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseFeed } from "../src/feed.js";

test("preserves German/English metadata and exposes invalid candidates", async () => {
  const candidates = parseFeed(
    await readFile("fixtures/bundestag.xml", "utf8"),
  );
  assert.equal(candidates.length, 3);
  assert.equal(
    candidates[0]?.headline,
    "Öffentliche Anhörung: Wohnen & Städte",
  );
  assert.equal(candidates[1]?.language, "en");
  assert.deepEqual(candidates[0]?.errors, []);
  assert.equal(candidates[2]?.errors.length, 2);
  assert.ok(!JSON.stringify(candidates).includes("description"));
});

test("rejects malformed XML, entities, wrong formats and oversized feeds", () => {
  for (const xml of [
    "<rss>",
    "<!DOCTYPE rss><rss/>",
    "<html/>",
    "x".repeat(1_000_001),
  ])
    assert.throws(() => parseFeed(xml));
});

test("missing dates stay unknown and empty entries remain inspectable", () => {
  const [candidate] = parseFeed(
    "<rss><channel><language>de</language><item/></channel></rss>",
  );
  assert.equal(candidate?.publishedAt, null);
  assert.deepEqual(candidate?.errors, [
    "Missing headline",
    "Invalid HTTP(S) original URL",
  ]);
});
