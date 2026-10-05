import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import pg from "pg";
import { collect, collectSearch } from "../src/import/service.js";
import type { SearchResult } from "../src/search.js";

const root = process.cwd();

const sharedUrl = "https://www.deutschlandfunk.de/shared-article-100.html";
const exaOnlyUrl = "https://www.tagesschau.de/exa-only-100.html";
const tavilyOnlyUrl = "https://www.deutschlandfunk.de/tavily-only-100.html";

const exaResults: SearchResult[] = [
  { url: sharedUrl, title: "Bildung und Schule im Fokus", rank: 1 },
  { url: exaOnlyUrl, title: "Schule braucht mehr Lehrkräfte", rank: 2 },
  { url: "https://example.org/off-domain.html", title: "Off domain", rank: 3 },
];

const tavilyResults: SearchResult[] = [
  { url: sharedUrl, title: "Bildung und Schule im Fokus", rank: 1 },
  { url: tavilyOnlyUrl, title: "Ausbildung und Schule im Wandel", rank: 2 },
];

const query = "Bildung Schule Ausbildung Deutschland";
const stubFetchArticle = async () => ({
  ok: false as const,
  reason: "Unsupported format: test stub holds no article",
});

test("search runs persist provenance and converge with RSS on one publication", async () => {
  const baseUrl = process.env.DATABASE_URL!;
  const admin = new pg.Pool({ connectionString: baseUrl });
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = `${baseUrl}?schema=${schema}`;
  process.env.DATABASE_URL = url;
  const env = { ...process.env, DATABASE_URL: url };
  try {
    await promisify(execFile)(
      "node_modules/.bin/prisma",
      ["migrate", "deploy"],
      { env, cwd: root },
    );
    const { database } = await import("../src/db.js");
    const prisma = database();
    try {
      const exa = await collectSearch(
        prisma,
        "search-exa-education",
        query,
        "exa",
        exaResults,
        stubFetchArticle,
      );
      assert.equal(exa.status, "completed");
      assert.equal(exa.sourceKind, "search_query");
      assert.equal(exa.validCount, 2);
      assert.equal(exa.invalidCount, 1);

      const tavily = await collectSearch(
        prisma,
        "search-tavily-education",
        query,
        "tavily",
        tavilyResults,
        stubFetchArticle,
      );
      assert.equal(tavily.status, "completed");
      assert.equal(tavily.validCount, 2);
      assert.equal(tavily.invalidCount, 0);

      // Both providers plus one RSS feed discover the shared URL: a single
      // publication with three discovery encounters, not three publications.
      const rssXml =
        `<rss><channel><language>de</language>` +
        `<item><title>Bildung und Schule im Fokus</title><link>${sharedUrl}</link>` +
        `<guid>shared-article-100</guid></item></channel></rss>`;
      await collect(prisma, "rss-dlf", rssXml, {
        id: "deutschlandfunk-nachrichten",
        publisher: "Deutschlandfunk",
        url: "https://www.deutschlandfunk.de/nachrichten-100.rss",
        defaultLanguage: "de",
      }, stubFetchArticle);

      assert.equal(await prisma.publication.count(), 3);
      const shared = await prisma.publication.findFirstOrThrow({
        where: { originalUrl: sharedUrl },
      });
      assert.equal(
        await prisma.discovery.count({
          where: { publicationId: shared.id },
        }),
        3,
      );

      // Query/provider/rank provenance survives on runs and candidates.
      const runs = await prisma.run.findMany({ orderBy: [{ id: "asc" }] });
      assert.deepEqual(
        runs.map((r) => [r.id, r.sourceKind, r.feedId]),
        [
          ["rss-dlf", "news_feed", "deutschlandfunk-nachrichten"],
          ["search-exa-education", "search_query", query],
          ["search-tavily-education", "search_query", query],
        ],
      );
      const exaRun = runs[1]!;
      assert.deepEqual(exaRun.sourceScope, {
        domains: ["tagesschau.de", "deutschlandfunk.de"],
        provider: "exa",
        query,
      });
      const candidates = await prisma.candidate.findMany({
        where: { runId: "search-exa-education" },
        orderBy: [{ itemIndex: "asc" }],
      });
      assert.deepEqual(
        candidates.map((c) => [
          (c.metadata as { rank: number }).rank,
          (c.metadata as { provider: string }).provider,
          (c.metadata as { query: string }).query,
        ]),
        [
          [1, "exa", query],
          [2, "exa", query],
          [3, "exa", query],
        ],
      );

      // Replaying a settled search run creates nothing new.
      const replay = await collectSearch(
        prisma,
        "search-exa-education",
        query,
        "exa",
        exaResults,
        stubFetchArticle,
      );
      assert.equal(replay.validCount, 2);
      assert.equal(await prisma.publication.count(), 3);
      assert.equal(await prisma.discovery.count(), 5);
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
