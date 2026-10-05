import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterSearchResults,
  isAllowedSearchHost,
  isAllowedSearchUrl,
  searchAllowedDomains,
  searchQueries,
} from "../src/search.js";

test("six fixed German queries cover the required subjects", () => {
  assert.equal(searchQueries.length, 6);
  assert.deepEqual(
    searchQueries.map((q) => q.subject),
    [
      "politics",
      "employment",
      "housing",
      "healthcare",
      "education",
      "immigration",
    ],
  );
  assert.ok(searchQueries.every((q) => q.query.trim().length > 0));
  assert.equal(new Set(searchQueries.map((q) => q.query)).size, 6);
});

test("launch allowlist holds only tagesschau and deutschlandfunk", () => {
  assert.deepEqual([...searchAllowedDomains], [
    "tagesschau.de",
    "deutschlandfunk.de",
  ]);
});

test("allowlist accepts subdomains and rejects other hosts", () => {
  assert.ok(isAllowedSearchHost("www.tagesschau.de"));
  assert.ok(isAllowedSearchHost("www.deutschlandfunk.de"));
  assert.ok(isAllowedSearchHost("tagesschau.de"));
  for (const host of ["example.org", "tagesschau.de.evil.org", "", "  "])
    assert.equal(isAllowedSearchHost(host), false);
});

test("result URLs require http(s) on an allowed host", () => {
  assert.ok(
    isAllowedSearchUrl("https://www.tagesschau.de/inland/a-100.html"),
  );
  assert.ok(
    isAllowedSearchUrl("https://www.deutschlandfunk.de/politik-100.html"),
  );
  for (const url of [
    "https://example.org/a.html",
    "ftp://www.tagesschau.de/a.html",
    "notaurl",
    "",
  ])
    assert.equal(isAllowedSearchUrl(url), false);
});

test("filter keeps only allowlisted results including resolved destinations", () => {
  const kept = filterSearchResults([
    {
      url: "https://www.tagesschau.de/inland/a-100.html",
      title: "A",
      rank: 1,
    },
    {
      url: "https://www.deutschlandfunk.de/politik-100.html",
      title: "B",
      rank: 2,
    },
    { url: "https://example.org/c.html", title: "C", rank: 3 },
  ]);
  assert.equal(kept.length, 2);
  assert.deepEqual(
    kept.map((r) => r.url),
    [
      "https://www.tagesschau.de/inland/a-100.html",
      "https://www.deutschlandfunk.de/politik-100.html",
    ],
  );
});
