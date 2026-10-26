import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import pg from "pg";
import { collect, collectSearch } from "../src/import/service.js";
import { EXTRACT_TEXT } from "../src/import/publication.js";
import type { SearchResult } from "../src/search.js";

const root = process.cwd();

const query = "Bildung Schule Ausbildung Deutschland";
const sharedUrl = "https://www.deutschlandfunk.de/shared-provenance-100.html";

const searchResults: SearchResult[] = [
  { url: sharedUrl, title: "Bildung und Schule im Fokus", rank: 1 },
];

const feed = {
  id: "deutschlandfunk-nachrichten",
  publisher: "Deutschlandfunk",
  url: "https://www.deutschlandfunk.de/nachrichten-100.rss",
  defaultLanguage: "de" as const,
};

const rssXml =
  `<rss><channel><language>de</language>` +
  `<item><title>Bildung und Schule im Fokus</title><link>${sharedUrl}</link>` +
  `<guid>shared-provenance-100</guid></item></channel></rss>`;

const text60 = "Body sentence one. ".repeat(10);
const okFetchArticle = async (url: string) => ({
  ok: true as const,
  finalUrl: url,
  html: `<html><body><article><h1>Headline</h1><p>${text60}</p></article></body></html>`,
});

async function isolatedDb() {
  const baseUrl = process.env.DATABASE_URL!;
  const admin = new pg.Pool({ connectionString: baseUrl });
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = `${baseUrl}?schema=${schema}`;
  process.env.DATABASE_URL = url;
  // Prisma migrate prefers DATABASE_URL_UNPOOLED when set (prisma.config.ts).
  process.env.DATABASE_URL_UNPOOLED = url;
  await promisify(execFile)("node_modules/.bin/prisma", ["migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    cwd: root,
  });
  const { database } = await import("../src/db.js");
  return {
    prisma: database(),
    done: async () => {
      process.env.DATABASE_URL = baseUrl;
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test("feed and search converge on one publication; extraction keeps parent source", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    await collectSearch(
      prisma,
      "search-provenance",
      query,
      "exa",
      searchResults,
      okFetchArticle,
    );
    assert.equal(await prisma.publication.count(), 1);
    const shared = await prisma.publication.findFirstOrThrow({
      where: { originalUrl: sharedUrl },
    });

    const searchExtract = await prisma.processingJob.findFirstOrThrow({
      where: { runId: "search-provenance", operation: EXTRACT_TEXT },
    });
    assert.equal(searchExtract.sourceKind, "search_query");
    assert.equal(searchExtract.sourceKey, query);
    const scope = searchExtract.sourceScope as {
      provider: string;
      domains: string[];
    };
    assert.equal(scope.provider, "exa");
    assert.deepEqual(scope.domains, ["tagesschau.de", "deutschlandfunk.de"]);

    await collect(prisma, "feed-provenance", rssXml, feed, okFetchArticle);
    assert.equal(await prisma.publication.count(), 1);
    assert.equal(
      await prisma.discovery.count({
        where: { publicationId: shared.id },
      }),
      2,
    );

    const feedExtract = await prisma.processingJob.findFirstOrThrow({
      where: { runId: "feed-provenance", operation: EXTRACT_TEXT },
    });
    assert.equal(feedExtract.sourceKind, "news_feed");
    assert.equal(feedExtract.sourceKey, feed.id);

    // ADR 0001: extracted text lives in versions under the one publication,
    // not as overwritten publication text or a forked duplicate.
    const versions = await prisma.publicationVersion.findMany({
      where: { publicationId: shared.id },
    });
    assert.ok(versions.length >= 1);
    assert.equal(await prisma.publicationVersion.count(), versions.length);
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("repeated discovery reuses the publication instead of forking", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    await collect(prisma, "repeat-one", rssXml, feed, okFetchArticle);
    await collect(prisma, "repeat-two", rssXml, feed, okFetchArticle);
    assert.equal(await prisma.publication.count(), 1);
    const shared = await prisma.publication.findFirstOrThrow({
      where: { originalUrl: sharedUrl },
    });
    assert.equal(
      await prisma.discovery.count({
        where: { publicationId: shared.id },
      }),
      2,
    );
    assert.equal(
      await prisma.candidate.count({ where: { publicationId: shared.id } }),
      2,
    );
  } finally {
    await prisma.$disconnect();
    await done();
  }
});
