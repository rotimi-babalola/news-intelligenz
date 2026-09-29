import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import pg from "pg";
import { collect } from "../src/collect.js";
import type { Feed } from "../src/sources.js";

const root = process.cwd();

function feed(publisher: string): Feed {
  return {
    id: `identity-${publisher}`,
    publisher,
    url: "https://example.org/identity.rss",
    defaultLanguage: "de",
  };
}

const item = (title: string, link: string, guid: string) =>
  `<item><title>${title}</title><link>${link}</link><guid>${guid}</guid>` +
  `<pubDate>Tue, 22 Sep 2026 08:00:00 +0200</pubDate></item>`;

const xml = (items: string) =>
  `<rss><channel><language>de</language>${items}</channel></rss>`;

test("URL aliases share one publication; publishers and titles never merge", async () => {
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
      const dl = feed("Deutschlandfunk");
      // Same article under alias URLs resolves to one publication.
      await collect(
        prisma,
        "alias-a",
        xml(item("Headline", "https://example.org/a.html", "a-1")),
        dl,
      );
      await collect(
        prisma,
        "alias-b",
        xml(
          item(
            "Headline",
            "https://example.org/a.html/?utm_source=rss#teil",
            "a-1",
          ),
        ),
        dl,
      );
      const dlPubs = await prisma.publication.findMany({
        where: { publisher: "deutschlandfunk" },
      });
      assert.equal(dlPubs.length, 1);
      assert.equal(
        await prisma.discovery.count({
          where: { publicationId: dlPubs[0]!.id },
        }),
        2,
      );
      // Raw original URL is preserved on the row.
      assert.equal(dlPubs[0]!.originalUrl, "https://example.org/a.html");

      // Publisher case/whitespace variants share the same identity scope.
      await collect(
        prisma,
        "case-variant",
        xml(item("Headline", "https://example.org/a.html", "a-1")),
        feed("DEUTSCHLANDFUNK "),
      );
      assert.equal(
        await prisma.publication.count({
          where: { publisher: "deutschlandfunk" },
        }),
        1,
      );
      assert.equal(
        await prisma.discovery.count({
          where: { publicationId: dlPubs[0]!.id },
        }),
        3,
      );

      // Same URL under another publisher stays separate.
      await collect(
        prisma,
        "other-pub",
        xml(item("Headline", "https://example.org/a.html", "a-1")),
        feed("Tagesschau"),
      );
      assert.equal(await prisma.publication.count(), 2);

      // Same headline with distinct URLs stays separate: titles never merge.
      await collect(
        prisma,
        "same-title",
        xml(item("Headline", "https://example.org/b.html", "b-1")),
        dl,
      );
      assert.equal(await prisma.publication.count(), 3);

      // Concurrent first encounters create one publication with two discoveries.
      await Promise.all([
        collect(
          prisma,
          "race-a",
          xml(item("Race", "https://example.org/race.html", "race-1")),
          dl,
        ),
        collect(
          prisma,
          "race-b",
          xml(item("Race", "https://example.org/race.html", "race-1")),
          dl,
        ),
      ]);
      assert.equal(
        await prisma.publication.count({
          where: { originalUrl: "https://example.org/race.html" },
        }),
        1,
      );
      const race = await prisma.publication.findFirstOrThrow({
        where: { originalUrl: "https://example.org/race.html" },
      });
      assert.equal(
        await prisma.discovery.count({ where: { publicationId: race.id } }),
        2,
      );
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    process.env.DATABASE_URL = baseUrl;
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
