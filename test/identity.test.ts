import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalArticleUrl,
  normalizeIdentifierValue,
  normalizePublisher,
} from "../src/identity.js";

test("publisher names fold case and whitespace", () => {
  assert.equal(normalizePublisher(" Deutschlandfunk  "), "deutschlandfunk");
  assert.equal(normalizePublisher("tagesschau (ARD)"), "tagesschau (ard)");
  assert.equal(normalizePublisher("WDR\t\nAktuell"), "wdr aktuell");
});

test("URL aliases canonicalize to one identity", () => {
  const base = "https://www.deutschlandfunk.de/shared-1.html";
  for (const alias of [
    "https://www.deutschlandfunk.de/shared-1.html/",
    "https://www.deutschlandfunk.de/shared-1.html#abschnitt",
    "HTTPS://WWW.DEUTSCHLANDFUNK.DE/shared-1.html",
    "https://www.deutschlandfunk.de:443/shared-1.html",
    "https://www.deutschlandfunk.de/shared-1.html?utm_source=rss",
    "https://www.deutschlandfunk.de/shared-1.html?utm_medium=rss&utm_source=rss",
  ])
    assert.equal(canonicalArticleUrl(alias), base);
  assert.equal(
    canonicalArticleUrl(
      "https://www.deutschlandfunk.de/shared-1.html?x=1&utm_source=rss",
    ),
    "https://www.deutschlandfunk.de/shared-1.html?x=1",
  );
  assert.equal(
    canonicalArticleUrl("https://example.org/a?b=2&a=1"),
    "https://example.org/a?a=1&b=2",
  );
});

test("identity-bearing URL information survives", () => {
  assert.notEqual(
    canonicalArticleUrl("https://example.org/a?id=1"),
    canonicalArticleUrl("https://example.org/a?id=2"),
  );
  assert.notEqual(
    canonicalArticleUrl("https://example.org/Aufmacher"),
    canonicalArticleUrl("https://example.org/aufmacher"),
  );
  assert.equal(canonicalArticleUrl("not a url"), "not a url");
  assert.equal(canonicalArticleUrl(""), "");
});

test("identifier values canonicalize URLs but pass through slugs", () => {
  assert.equal(
    normalizeIdentifierValue("https://example.org/a/?utm_source=rss"),
    "https://example.org/a",
  );
  assert.equal(normalizeIdentifierValue("  shared-1  "), "shared-1");
  assert.equal(normalizeIdentifierValue(""), "");
});
