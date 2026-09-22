import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseFeed } from "../src/feed.js";
import { fixtureFeed } from "../src/sources.js";

test("preserves German/English metadata and exposes invalid candidates", async () => {
  const candidates = parseFeed(
    await readFile("fixtures/bundestag.xml", "utf8"),
    fixtureFeed.defaultLanguage,
  );
  assert.equal(candidates.length, 3);
  assert.equal(
    candidates[0]?.headline,
    "Öffentliche Anhörung: Wohnen & Städte",
  );
  assert.equal(candidates[1]?.language, "en");
  assert.deepEqual(candidates[0]?.errors, []);
  assert.equal(candidates[2]?.errors.length, 2);
  assert.equal(candidates[2]?.sourceDate, "not-a-date");
  assert.ok(!JSON.stringify(candidates).includes("description"));
});

test("parses a public-news RSS 2.0 payload like Deutschlandfunk Nachrichten", () => {
  const candidates = parseFeed(
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
      <channel>
        <title>Deutschlandfunk - Fortlaufende Nachrichten</title>
        <link>https://www.deutschlandfunk.de/nachrichten-index-40126.html</link>
        <description>></description>
        <pubDate>Tue, 22 Sep 2026 09:02:39 +0200</pubDate>
        <item>
          <title>Bundeskabinett beschließt erneuten Tankrabatt</title>
          <link>https://www.deutschlandfunk.de/bundeskabinett-beschliesst-erneuten-tankrabatt-102.html</link>
          <description><![CDATA[<img src="https://bilder.deutschlandfunk.de/x.jpg"/>Das Bundeskabinett hat am Abend die Senkung der Energiesteuer beschlossen.]]></description>
          <guid isPermaLink="false">bundeskabinett-beschliesst-erneuten-tankrabatt-102</guid>
          <pubDate>Tue, 22 Sep 2026 08:59:17 +0200</pubDate>
        </item>
      </channel>
    </rss>`,
  );
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(
    candidate?.headline,
    "Bundeskabinett beschließt erneuten Tankrabatt",
  );
  assert.equal(
    candidate?.originalUrl,
    "https://www.deutschlandfunk.de/bundeskabinett-beschliesst-erneuten-tankrabatt-102.html",
  );
  assert.equal(
    candidate?.sourceId,
    "bundeskabinett-beschliesst-erneuten-tankrabatt-102",
  );
  assert.equal(candidate?.publishedAt, "2026-09-22T06:59:17.000Z");
  assert.equal(candidate?.language, "de");
  assert.deepEqual(candidate?.errors, []);
});

test("undeclared feed language falls back to the configured default", () => {
  const [candidate] = parseFeed(
    "<rss><channel><item><title>Headline</title><link>https://example.org/a</link></item></channel></rss>",
    "en",
  );
  assert.equal(candidate?.language, "en");
});

test("BCP-47 language tags normalize to the primary subtag", () => {
  const [candidate] = parseFeed(
    "<rss><channel><language>de-DE</language><item><title>Headline</title><link>https://example.org/a</link></item></channel></rss>",
  );
  assert.equal(candidate?.language, "de");
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
