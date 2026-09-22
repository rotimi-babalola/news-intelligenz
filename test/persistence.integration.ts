import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { get } from "node:http";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { collect } from "../src/collect.js";
import { fixtureFeed } from "../src/sources.js";

const root = process.cwd();

async function startAdmin(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    env: { ...env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Server did not start: ${output}`));
    }, 10000);
    child.stderr.on("data", (data) => {
      output += data.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited ${code}: ${output}`));
    });
    child.stdout.on("data", (data) => {
      output += data.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
  });
  return {
    url,
    stop: async () => {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    },
  };
}

test("PostgreSQL retains candidates and distinct discoveries; replay is idempotent", async () => {
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
    const xml = await readFile("fixtures/bundestag.xml", "utf8");
    const run = () =>
      promisify(execFile)(
        process.execPath,
        ["dist/src/cli.js", "collect-fixture", "first"],
        { env },
      );
    const first = JSON.parse((await run()).stdout);
    assert.equal(first.validCount, 2);
    assert.equal(first.invalidCount, 1);
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      result.runs = await prisma.run.findMany({ orderBy: [{ id: "asc" }] });
      result.publications = await prisma.publication.findMany({
        orderBy: [{ id: "asc" }],
      });
      result.publicationIdentifiers =
        await prisma.publicationIdentifier.findMany({
          orderBy: [{ publisher: "asc" }, { kind: "asc" }, { value: "asc" }],
        });
      result.candidates = await prisma.candidate.findMany({
        orderBy: [{ runId: "asc" }, { itemIndex: "asc" }],
      });
      result.discoveries = await prisma.discovery.findMany({
        orderBy: [{ runId: "asc" }, { publicationId: "asc" }],
      });
      return result;
    };
    const saved = await snapshot();
    let server = await startAdmin(env);
    let initialPage: string;
    try {
      const response = await fetch(server.url);
      assert.equal(response.status, 200);
      initialPage = await response.text();
      assert.match(initialPage, /Öffentliche Anhörung: Wohnen &amp; Städte/);
      assert.match(initialPage, /Committee discusses healthcare access/);
      assert.match(initialPage, /Invalid publication date/);
      assert.match(initialPage, /not-a-date/);
      assert.match(initialPage, /Metadata only/);
      assert.equal((await fetch(`${server.url}/missing`)).status, 404);
      assert.equal((await fetch(server.url, { method: "POST" })).status, 405);
      const denied = await new Promise<number | undefined>(
        (resolve, reject) => {
          get(
            server.url,
            { headers: { Host: "attacker.example" } },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          ).on("error", reject);
        },
      );
      assert.equal(denied, 403);
    } finally {
      await server.stop();
    }
    assert.deepEqual(JSON.parse((await run()).stdout), first);
    assert.deepEqual(
      await snapshot(),
      saved,
      "a new collector process replays without altering any row",
    );
    server = await startAdmin(env);
    try {
      assert.equal(await (await fetch(server.url)).text(), initialPage);
    } finally {
      await server.stop();
    }
    await collect(prisma, "second", xml, fixtureFeed);
    const counts = {
      publications: await prisma.publication.count(),
      discoveries: await prisma.discovery.count(),
      candidates: await prisma.candidate.count(),
    };
    assert.deepEqual(counts, {
      publications: 2,
      discoveries: 4,
      candidates: 6,
    });
    await assert.rejects(
      collect(prisma, "first", xml + " ", fixtureFeed),
      /different input/,
    );
    assert.equal(
      (await collect(prisma, "broken", "<rss>", fixtureFeed)).status,
      "failed",
    );
    await Promise.all([
      collect(prisma, "concurrent", xml, fixtureFeed),
      collect(prisma, "concurrent", xml, fixtureFeed),
    ]);
    assert.equal(
      await prisma.discovery.count({ where: { runId: "concurrent" } }),
      2,
    );
    const conflict = xml.replace("fixture-de-1", "fixture-en-1");
    assert.equal(
      (await collect(prisma, "conflict", conflict, fixtureFeed)).invalidCount,
      2,
    );
    assert.equal(await prisma.publication.count(), 2);
    const duplicate = xml.replace(
      "</channel>",
      `${xml.match(/<item>[\s\S]*?<\/item>/)![0]}</channel>`,
    );
    assert.equal(
      (await collect(prisma, "duplicate", duplicate, fixtureFeed)).validCount,
      3,
    );
    assert.equal(
      await prisma.discovery.count({ where: { runId: "duplicate" } }),
      2,
    );
    // A database failure halfway through must roll back publications and the run.
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${schema}.reject_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected storage failure'; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER reject_candidate BEFORE INSERT ON ${schema}.candidates FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_candidate()`,
    );
    const beforeFailure = await snapshot();
    await assert.rejects(
      collect(
        prisma,
        "rollback",
        xml.replaceAll("fixture-de-1", "new-id").replaceAll("/wohnen", "/new"),
        fixtureFeed,
      ),
      /injected storage failure/,
    );
    assert.deepEqual(await snapshot(), beforeFailure);
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER reject_candidate ON ${schema}.candidates`,
    );
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION ${schema}.reject_candidate()`,
    );
    await collect(
      prisma,
      "html",
      xml.replace(
        "Öffentliche Anhörung: Wohnen &amp; Städte",
        "&lt;script&gt;alert(1)&lt;/script&gt;",
      ),
      fixtureFeed,
    );
    server = await startAdmin(env);
    try {
      const page = await (await fetch(`${server.url}/?run=html`)).text();
      assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.ok(!page.includes("<script>"));
    } finally {
      await server.stop();
    }
    await prisma.$disconnect();
  } finally {
    process.env.DATABASE_URL = baseUrl;
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
