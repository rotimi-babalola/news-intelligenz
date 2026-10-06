import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import pg from "pg";
import { collectSearch, reviewSearchCandidate } from "../src/import/service.js";
import type { SearchResult } from "../src/search.js";

const root = process.cwd();

const query = "Bildung Schule Ausbildung Deutschland";
const stubFetchArticle = async () => ({
  ok: false as const,
  reason: "Unsupported format: test stub holds no article",
});

const results: SearchResult[] = [
  {
    url: "https://www.deutschlandfunk.de/schule-personal-100.html",
    title: "Schule braucht mehr Personal",
    rank: 1,
  },
  {
    url: "https://www.tagesschau.de/tankrabatt-100.html",
    title: "Kabinett beschließt Tankrabatt",
    rank: 2,
  },
  {
    url: "https://www.tagesschau.de/klima-100.html",
    title: "Kommunen fordern Klimageld",
    rank: 3,
  },
];

test("agent accepts matching headlines; uncertain stays out until reviewed", async () => {
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
      const run = await collectSearch(
        prisma,
        "search-review",
        query,
        "exa",
        results,
        stubFetchArticle,
      );
      assert.equal(run.status, "completed");
      // Only the query-matching headline entered shared processing.
      assert.equal(run.validCount, 1);
      assert.equal(await prisma.publication.count(), 1);
      assert.equal(await prisma.discovery.count(), 1);

      const reviews = await prisma.relevanceReview.findMany({
        orderBy: [{ itemIndex: "asc" }],
      });
      assert.deepEqual(
        reviews.map((r) => [r.itemIndex, r.decision, r.decidedBy]),
        [
          [0, "accepted", "agent"],
          [1, "uncertain", "agent"],
          [2, "uncertain", "agent"],
        ],
      );
      assert.match(reviews[0]!.reason, /schule/);

      // Operator accepts one uncertain candidate: it joins processing.
      const accepted = await reviewSearchCandidate(
        prisma,
        "search-review",
        1,
        "accepted",
        "Relevant to education policy",
        stubFetchArticle,
      );
      assert.equal(accepted?.decision, "accepted");
      assert.equal(accepted?.decidedBy, "operator");
      assert.equal(await prisma.publication.count(), 2);
      assert.equal(await prisma.discovery.count(), 2);

      // Operator rejects the other: excluded but inspectable.
      await reviewSearchCandidate(
        prisma,
        "search-review",
        2,
        "rejected",
        "Off-topic for the six subjects",
        stubFetchArticle,
      );
      assert.equal(await prisma.publication.count(), 2);
      const rejected = await prisma.relevanceReview.findUniqueOrThrow({
        where: { runId_itemIndex: { runId: "search-review", itemIndex: 2 } },
      });
      assert.equal(rejected.decision, "rejected");
      assert.equal(rejected.reason, "Off-topic for the six subjects");

      // Re-accepting an already resolved candidate is a safe no-op.
      await reviewSearchCandidate(
        prisma,
        "search-review",
        0,
        "accepted",
        "Confirmed relevant",
        stubFetchArticle,
      );
      assert.equal(await prisma.publication.count(), 2);
      assert.equal(await prisma.discovery.count(), 2);

      // Guards: invalid items, empty reasons and RSS runs stay out.
      await assert.rejects(
        reviewSearchCandidate(
          prisma,
          "search-review",
          1,
          "accepted",
          "   ",
          stubFetchArticle,
        ),
        /reason is required/,
      );
      await assert.rejects(
        reviewSearchCandidate(
          prisma,
          "missing-run",
          0,
          "accepted",
          "reason",
          stubFetchArticle,
        ),
      );
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
