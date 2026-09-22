import assert from "node:assert/strict";
import { test } from "node:test";
import { customFeed, fixtureFeed, publicNewsFeeds } from "../src/sources.js";

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

test("launch config holds the nine public-news feeds and no live Bundestag feed", () => {
  assert.equal(publicNewsFeeds.length, 9);
  assert.deepEqual(
    publicNewsFeeds.map((f) => f.url),
    [
      "https://www.tagesschau.de/infoservices/alle-meldungen-100~rdf.xml",
      "https://www.deutschlandfunk.de/nachrichten-100.rss",
      "https://www.deutschlandfunk.de/politikportal-100.rss",
      "https://www.deutschlandfunk.de/wirtschaft-106.rss",
      "https://www.deutschlandfunk.de/wissen-106.rss",
      "https://www.deutschlandfunk.de/kulturportal-100.rss",
      "https://www.deutschlandfunk.de/europa-112.rss",
      "https://www.deutschlandfunk.de/gesellschaft-106.rss",
      "https://www.deutschlandfunk.de/sportportal-100.rss",
    ],
  );
  assert.ok(publicNewsFeeds.every((f) => f.defaultLanguage === "de" && f.url));
  assert.equal(new Set(publicNewsFeeds.map((f) => f.id)).size, 9);
  assert.ok(publicNewsFeeds.every((f) => !f.url?.includes("bundestag.de")));
  assert.equal(fixtureFeed.url, null);
});
