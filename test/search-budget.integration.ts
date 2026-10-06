import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import pg from "pg";
import { collect, collectSearchQuery } from "../src/import/service.js";

const root = process.cwd();

const stubFetchArticle = async () => ({
  ok: false as const,
  reason: "Unsupported format: test stub holds no article",
});

const stubProviderFetch = (async () =>
  new Response(
    JSON.stringify({
      results: [
        {
          url: "https://www.deutschlandfunk.de/schule-100.html",
          title: "Schule braucht mehr Personal",
        },
      ],
    }),
    { status: 200 },
  )) as typeof fetch;

test("exhausted provider pauses while RSS collection continues", async () => {
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
      const first = await collectSearchQuery(
        prisma,
        "search-budget-exa-1",
        "Bildung Schule Ausbildung Deutschland",
        "exa",
        {
          apiKey: "test-exa-key",
          monthlyCallBudget: 1,
          fetchFn: stubProviderFetch,
          fetchArticle: stubFetchArticle,
        },
      );
      assert.equal(first.status, "completed");
      assert.equal(first.status === "completed" && first.valid, 1);
      assert.equal(first.status === "completed" && first.usage.calls, 1);

      // Budget spent: the provider pauses with a visible reason, no new run.
      const paused = await collectSearchQuery(
        prisma,
        "search-budget-exa-2",
        "Bildung Schule Ausbildung Deutschland",
        "exa",
        {
          apiKey: "test-exa-key",
          monthlyCallBudget: 1,
          fetchFn: stubProviderFetch,
          fetchArticle: stubFetchArticle,
        },
      );
      assert.equal(paused.status, "paused");
      assert.match(
        paused.status === "paused" ? paused.reason : "",
        /exa.*budget exhausted.*RSS collection continues/,
      );
      assert.equal(
        await prisma.run.count({
          where: { sourceKind: "search_query" },
        }),
        1,
      );

      // Budgets are per provider: tavily still collects.
      const other = await collectSearchQuery(
        prisma,
        "search-budget-tavily-1",
        "Bildung Schule Ausbildung Deutschland",
        "tavily",
        {
          apiKey: "test-tavily-key",
          monthlyCallBudget: 1,
          fetchFn: stubProviderFetch,
          fetchArticle: stubFetchArticle,
        },
      );
      assert.equal(other.status, "completed");

      // Independent RSS work continues alongside the paused provider.
      const rss = await collect(
        prisma,
        "rss-after-pause",
        `<rss><channel><language>de</language>` +
          `<item><title>Nachrichten</title>` +
          `<link>https://www.deutschlandfunk.de/nachrichten-100.html</link>` +
          `<guid>news-100</guid></item></channel></rss>`,
        {
          id: "deutschlandfunk-nachrichten",
          publisher: "Deutschlandfunk",
          url: "https://www.deutschlandfunk.de/nachrichten-100.rss",
          defaultLanguage: "de",
        },
        stubFetchArticle,
      );
      assert.equal(rss.error, null);
      assert.equal(rss.validCount, 1);
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
