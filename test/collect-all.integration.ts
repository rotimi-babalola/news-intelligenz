import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import pg from "pg";
import { collectAll } from "../src/import/service.js";
import type { Feed } from "../src/sources.js";

const root = process.cwd();

const sharedItem =
  `<item><title>Shared headline</title>` +
  `<link>https://www.deutschlandfunk.de/shared-1.html</link>` +
  `<guid>shared-1</guid>` +
  `<pubDate>Tue, 22 Sep 2026 08:00:00 +0200</pubDate></item>`;

const xmlA =
  `<rss><channel><language>de</language>${sharedItem}` +
  `<item><title>Sport: only in A</title>` +
  `<link>https://www.deutschlandfunk.de/sport-only.html</link>` +
  `<guid>sport-only</guid></item></channel></rss>`;

const xmlB =
  `<rss><channel><language>de</language>${sharedItem}` +
  `<item><title>Kultur: only in B</title>` +
  `<link>https://www.deutschlandfunk.de/kultur-only.html</link>` +
  `<guid>kultur-only</guid></item></channel></rss>`;

const malformed =
  `<rss><channel><language>de</language>` +
  `<item><title>Bad entry</title><link>javascript:alert(1)</link></item>` +
  `</channel></rss>`;

function feed(id: string, url: string): Feed {
  return { id, publisher: "Deutschlandfunk", url, defaultLanguage: "de" };
}

test("collectAll shares identity across feeds and isolates failures", async () => {
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
      {
        env,
        cwd: root,
      },
    );
    const { database } = await import("../src/db.js");
    const prisma = database();
    try {
      const feeds = [
        feed("feed-a", "https://example.org/a.rss"),
        feed("feed-b", "https://example.org/b.rss"),
        feed("feed-malformed", "https://example.org/bad.rss"),
        feed("feed-down", "https://example.org/down.rss"),
      ];
      const fetchXml = async (fetchUrl: string) => {
        if (fetchUrl === "https://example.org/a.rss") return xmlA;
        if (fetchUrl === "https://example.org/b.rss") return xmlB;
        if (fetchUrl === "https://example.org/bad.rss") return malformed;
        throw new Error("boom: connection refused");
      };
      const results = await collectAll(prisma, "it", fetchXml, feeds);
      assert.deepEqual(
        results.map((r) => ({
          feedId: r.feedId,
          status: r.status,
          valid: r.valid,
          invalid: r.invalid,
        })),
        [
          { feedId: "feed-a", status: "completed", valid: 2, invalid: 0 },
          { feedId: "feed-b", status: "completed", valid: 2, invalid: 0 },
          {
            feedId: "feed-malformed",
            status: "completed",
            valid: 0,
            invalid: 1,
          },
          { feedId: "feed-down", status: "failed", valid: 0, invalid: 0 },
        ],
      );
      // The same publication in two feeds shares one identity with two encounters.
      assert.equal(
        await prisma.publication.count({
          where: {
            originalUrl: "https://www.deutschlandfunk.de/shared-1.html",
          },
        }),
        1,
      );
      const shared = await prisma.publication.findFirstOrThrow({
        where: { originalUrl: "https://www.deutschlandfunk.de/shared-1.html" },
      });
      assert.equal(
        await prisma.discovery.count({ where: { publicationId: shared.id } }),
        2,
      );
      assert.equal(await prisma.publication.count(), 3);
      assert.equal(await prisma.discovery.count(), 4);
      // Failures remain visible per feed without losing other sources' results.
      const failedRun = await prisma.run.findUniqueOrThrow({
        where: { id: "it:feed-down" },
      });
      assert.equal(failedRun.feedId, "feed-down");
      assert.equal(failedRun.status, "failed");
      assert.match(failedRun.error ?? "", /boom: connection refused/);
      const feedIds = (
        await prisma.run.findMany({ select: { feedId: true } })
      ).map((r) => r.feedId);
      assert.deepEqual([...feedIds].sort(), [
        "feed-a",
        "feed-b",
        "feed-down",
        "feed-malformed",
      ]);
      // Source identifiers and provenance survive per run.
      for (const runId of ["it:feed-a", "it:feed-b"]) {
        const candidate = await prisma.candidate.findFirstOrThrow({
          where: { runId, itemIndex: 0 },
        });
        assert.deepEqual(
          (candidate.metadata as { sourceId: unknown }).sourceId,
          "shared-1",
        );
        assert.deepEqual(
          (candidate.metadata as { originalUrl: unknown }).originalUrl,
          "https://www.deutschlandfunk.de/shared-1.html",
        );
      }
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    process.env.DATABASE_URL = baseUrl;
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
