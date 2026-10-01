import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { get } from "node:http";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { collect } from "../src/import/service.js";
import { fixtureFeed } from "../src/sources.js";

const root = process.cwd();

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = (address as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function startNext(env: NodeJS.ProcessEnv) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "-H",
      "127.0.0.1",
      "-p",
      String(port),
    ],
    { env, stdio: ["ignore", "pipe", "pipe"], cwd: root },
  );
  child.stdout.resume();
  let output = "";
  child.stderr.on("data", (data) => {
    output += data.toString();
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Next exited ${child.exitCode}: ${output}`);
    }
    try {
      const response = await fetch(`${url}/admin`);
      if (response.status === 200) {
        await response.text();
        break;
      }
    } catch {
      // Not accepting connections yet.
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`Next did not start: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
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
    let server = await startNext(env);
    const postFixture = async (runId: string) => {
      const response = await fetch(`${server.url}/api/collect-fixture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const first = await postFixture("first");
    assert.equal(first.validCount, 2);
    assert.equal(first.invalidCount, 1);
    const invalid = await fetch(`${server.url}/api/collect-fixture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "  " }),
    });
    assert.equal(invalid.status, 400);
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
    let initialPage: string;
    try {
      const response = await fetch(`${server.url}/admin`);
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
            `${server.url}/admin`,
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
    server = await startNext(env);
    try {
      const replay = await postFixture("first");
      assert.deepEqual(replay, first);
      assert.deepEqual(
        await snapshot(),
        saved,
        "a restarted server replays without altering any row",
      );
      assert.equal(
        await (await fetch(`${server.url}/admin`)).text(),
        initialPage,
      );
      const stuck = await prisma.processingJob.findFirstOrThrow({
        where: { runId: "first" },
      });
      await prisma.processingJob.update({
        where: { id: stuck.id },
        data: { status: "exhausted", attempts: 5, lastError: "operator case" },
      });
      const jobsPage = await (await fetch(`${server.url}/admin`)).text();
      assert.match(jobsPage, new RegExp(stuck.id));
      assert.match(jobsPage, /Retry<\/button>/);
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
    server = await startNext(env);
    try {
      const page = await (await fetch(`${server.url}/admin?run=html`)).text();
      assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.ok(!page.includes("<script>alert(1)</script>"));
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
