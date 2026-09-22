import assert from "node:assert/strict";
import { test } from "node:test";
import { customFeed } from "../src/sources.js";

test("custom feed derives a stable per-URL identity scoped by host", () => {
  const first = customFeed(
    "https://www.deutschlandfunk.de/politikportal-100.rss",
  );
  const second = customFeed(
    "https://www.deutschlandfunk.de/politikportal-100.rss",
  );
  assert.equal(first.id, second.id);
  assert.equal(first.publisher, "www.deutschlandfunk.de");
  assert.ok(first.id.startsWith("custom-www.deutschlandfunk.de-"));
  const other = customFeed("https://www.deutschlandfunk.de/wirtschaft-106.rss");
  assert.notEqual(first.id, other.id);
  assert.equal(other.publisher, first.publisher);
  assert.equal(first.defaultLanguage, "de");
});

test("custom feed rejects non-HTTP(S) URLs", () => {
  for (const url of ["notaurl", "", "ftp://example.org/feed.xml"])
    assert.throws(() => customFeed(url), /absolute HTTP\(S\) URL/);
});
