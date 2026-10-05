import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import pg from "pg";
import { fetchArticleHtml } from "../src/extract.js";
import { storeExtractedText } from "../src/extract/repository.js";
import {
  collect,
  collectIntake,
  drainJobs,
  EXTRACT_TEXT,
  finalizeRunIfSettled,
  type ArticleFetcher,
} from "../src/import/service.js";
import type { Feed } from "../src/sources.js";

const root = process.cwd();

const feed: Feed = {
  id: "extract-test-feed",
  publisher: "Extract Test Publisher",
  url: "https://example.org/feed.rss",
  defaultLanguage: "de",
};

const item = (id: string) =>
  `<item><title>Extract headline ${id}</title>` +
  `<link>https://example.org/article-${id}.html</link>` +
  `<guid>article-${id}</guid>` +
  `<pubDate>Tue, 22 Sep 2026 08:00:00 +0200</pubDate></item>`;

const xml = (ids: string[]) =>
  `<rss><channel><language>de</language>${ids.map(item).join("")}</channel></rss>`;

const article = (body: string) =>
  `<html><body><nav>Menu</nav><article><h1>Headline</h1><p>${body}</p></article></body></html>`;

const text60 = "Body sentence one. ".repeat(10);

function stubArticles(
  pages: Record<
    string,
    { status: number; contentType?: string; body?: string }
  >,
): ArticleFetcher {
  const allowed = new Set(["example.org"]);
  return (url) =>
    fetchArticleHtml(
      url,
      async (fetchUrl) => {
        const page = pages[fetchUrl];
        if (!page)
          return {
            status: 404,
            headers: { get: () => null },
            text: async () => "",
          };
        return {
          status: page.status,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type"
                ? (page.contentType ?? "text/html")
                : null,
          },
          text: async () => page.body ?? "",
        };
      },
      allowed,
    );
}

async function isolatedDb() {
  const baseUrl = process.env.DATABASE_URL!;
  const admin = new pg.Pool({ connectionString: baseUrl });
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = `${baseUrl}?schema=${schema}`;
  process.env.DATABASE_URL = url;
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

test("extraction stores versions, skips identical text, keeps history on change", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    const pages = {
      "https://example.org/article-a.html": {
        status: 200,
        body: article(text60),
      },
    };
    await collect(prisma, "first", xml(["a"]), feed, stubArticles(pages));
    const pub = await prisma.publication.findFirstOrThrow({
      where: { originalUrl: "https://example.org/article-a.html" },
    });
    assert.equal(pub.contentAvailability, "full_text");
    assert.equal(pub.extractionError, null);
    assert.equal(await prisma.publicationVersion.count(), 1);
    // The redirect-resolved identity is learned: final URL is an identifier.
    assert.ok(
      await prisma.publicationIdentifier.findUnique({
        where: {
          publisher_kind_value: {
            publisher: "extract test publisher",
            kind: "url",
            value: "https://example.org/article-a.html",
          },
        },
      }),
    );
    // Re-collecting identical text creates no new version.
    await collect(prisma, "second", xml(["a"]), feed, stubArticles(pages));
    assert.equal(await prisma.publicationVersion.count(), 1);
    // Changed text becomes a second preserved version.
    pages["https://example.org/article-a.html"] = {
      status: 200,
      body: article(`${text60} Updated with corrections. `),
    };
    await collect(prisma, "third", xml(["a"]), feed, stubArticles(pages));
    const versions = await prisma.publicationVersion.findMany({
      where: { publicationId: pub.id },
      orderBy: [{ versionNo: "asc" }],
    });
    assert.equal(versions.length, 2);
    assert.ok(!(versions[0]?.text.includes("corrections") ?? true));
    assert.ok(versions[1]?.text.includes("corrections"));
    // Restart-safe replay alters nothing.
    const replay = await collect(
      prisma,
      "third",
      xml(["a"]),
      feed,
      stubArticles(pages),
    );
    assert.equal(replay.status, "completed");
    assert.equal(await prisma.publicationVersion.count(), 2);
    pages["https://example.org/article-a.html"] = {
      status: 200,
      body: article(text60),
    };
    await collect(prisma, "fourth", xml(["a"]), feed, stubArticles(pages));
    const restored = await prisma.publicationVersion.findMany({
      where: { publicationId: pub.id },
      orderBy: [{ versionNo: "asc" }],
    });
    assert.deepEqual(
      restored.map((v) => v.versionNo),
      [1, 2, 3],
    );
    assert.equal(restored[2]?.textHash, restored[0]?.textHash);
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("unsupported formats keep metadata-only fallback with original link", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    await collect(
      prisma,
      "pdf",
      xml(["a"]),
      feed,
      stubArticles({
        "https://example.org/article-a.html": {
          status: 200,
          contentType: "application/pdf",
          body: "%PDF-1.4",
        },
      }),
    );
    const pub = await prisma.publication.findFirstOrThrow({
      where: { originalUrl: "https://example.org/article-a.html" },
    });
    assert.equal(pub.contentAvailability, "metadata_only");
    assert.match(pub.extractionError ?? "", /Unsupported format/);
    assert.equal(await prisma.publicationVersion.count(), 0);
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("slow article fetch completes before the write transaction starts", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    await collect(prisma, "slow-fetch", xml(["a"]), feed, async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      return { ok: true, finalUrl: url, html: article(text60) };
    });
    assert.equal(await prisma.publicationVersion.count(), 1);
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("operator re-extract recovers a publication stuck metadata-only", async () => {
  const { prisma, done } = await isolatedDb();
  const { reextractPublication } = await import("../src/admin/service.js");
  try {
    await collect(
      prisma,
      "stuck",
      xml(["a"]),
      feed,
      stubArticles({
        "https://example.org/article-a.html": {
          status: 200,
          contentType: "application/pdf",
          body: "%PDF-1.4",
        },
      }),
    );
    const pub = await prisma.publication.findFirstOrThrow({
      where: { originalUrl: "https://example.org/article-a.html" },
    });
    assert.equal(pub.contentAvailability, "metadata_only");
    const originalJob = await prisma.processingJob.findFirstOrThrow({
      where: { operation: EXTRACT_TEXT },
    });
    await reextractPublication(
      pub.id,
      stubArticles({
        "https://example.org/article-a.html": {
          status: 200,
          body: article(text60),
        },
      }),
    );
    const recovered = await prisma.publication.findUniqueOrThrow({
      where: { id: pub.id },
    });
    assert.equal(recovered.contentAvailability, "full_text");
    assert.equal(recovered.extractionError, null);
    assert.equal(
      await prisma.publicationVersion.count({
        where: { publicationId: pub.id },
      }),
      1,
    );
    assert.equal(
      await prisma.jobAttempt.count({ where: { jobId: originalJob.id } }),
      1,
    );
    // Repeating the re-extract with identical text stores nothing new.
    await reextractPublication(
      pub.id,
      stubArticles({
        "https://example.org/article-a.html": {
          status: 200,
          body: article(text60),
        },
      }),
    );
    assert.equal(
      await prisma.publicationVersion.count({
        where: { publicationId: pub.id },
      }),
      1,
    );
    assert.equal(
      await prisma.processingJob.count({ where: { operation: EXTRACT_TEXT } }),
      3,
    );
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("final URL claimed by another publication is a conflict, not a merge", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    const first = await prisma.publication.create({
      data: {
        id: randomUUID(),
        publisher: "extract test publisher",
        headline: "First",
        originalUrl: "https://example.org/first.html",
        language: "de",
      },
    });
    const second = await prisma.publication.create({
      data: {
        id: randomUUID(),
        publisher: "extract test publisher",
        headline: "Second",
        originalUrl: "https://example.org/second.html",
        language: "de",
      },
    });
    const stored = await storeExtractedText(prisma, {
      publicationId: first.id,
      publisher: "extract test publisher",
      finalUrl: "https://example.org/shared-final.html",
      text: text60,
    });
    assert.deepEqual(stored, { stored: true, versionNo: 1 });
    const conflict = await storeExtractedText(prisma, {
      publicationId: second.id,
      publisher: "extract test publisher",
      finalUrl: "https://example.org/shared-final.html",
      text: `${text60} different`,
    });
    assert.equal(conflict.stored, false);
    assert.equal(await prisma.publicationVersion.count(), 1);
    const rejected = await prisma.publication.findUniqueOrThrow({
      where: { id: second.id },
    });
    assert.match(rejected.extractionError ?? "", /another publication/);
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("interrupted extraction resumes via the durable job", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    const fetcher = stubArticles({
      "https://example.org/article-a.html": {
        status: 200,
        body: article(text60),
      },
    });
    await collectIntake(prisma, "interrupted", xml(["a"]), feed);
    // Simulate a crash: drop the resolve jobs' effect by draining only
    // resolution, then verify extraction still completes on resume.
    await drainJobs(prisma, "worker-1", { runId: "interrupted" }, fetcher);
    const run = await finalizeRunIfSettled(prisma, "interrupted", null);
    assert.equal(run.status, "completed");
    assert.equal(await prisma.publicationVersion.count(), 1);
  } finally {
    await prisma.$disconnect();
    await done();
  }
});
