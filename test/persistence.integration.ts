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
import { database, migrate } from "../src/db.js";

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
  const admin = database();
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  try {
    await migrate(pool);
    const xml = await readFile("fixtures/bundestag.xml", "utf8");
    const env = { ...process.env, PGOPTIONS: `-c search_path=${schema}` };
    const run = () =>
      promisify(execFile)(
        process.execPath,
        ["dist/src/cli.js", "collect", "first"],
        { env },
      );
    const first = JSON.parse((await run()).stdout);
    assert.equal(first.valid_count, 2);
    assert.equal(first.invalid_count, 1);
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const table of [
        "runs",
        "publications",
        "publication_identifiers",
        "candidates",
        "discoveries",
      ])
        result[table] = (
          await pool.query(`SELECT * FROM ${table} ORDER BY 1, 2`)
        ).rows;
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
    await collect(pool, "second", xml);
    const counts = await pool.query(
      "SELECT (SELECT count(*) FROM publications)::int AS publications, (SELECT count(*) FROM discoveries)::int AS discoveries, (SELECT count(*) FROM candidates)::int AS candidates",
    );
    assert.deepEqual(counts.rows[0], {
      publications: 2,
      discoveries: 4,
      candidates: 6,
    });
    await assert.rejects(collect(pool, "first", xml + " "), /different input/);
    assert.equal((await collect(pool, "broken", "<rss>")).status, "failed");
    await Promise.all([
      collect(pool, "concurrent", xml),
      collect(pool, "concurrent", xml),
    ]);
    assert.equal(
      (
        await pool.query(
          "SELECT * FROM discoveries WHERE run_id = 'concurrent'",
        )
      ).rowCount,
      2,
    );
    const conflict = xml.replace("fixture-de-1", "fixture-en-1");
    assert.equal((await collect(pool, "conflict", conflict)).invalid_count, 2);
    assert.equal((await pool.query("SELECT * FROM publications")).rowCount, 2);
    const duplicate = xml.replace(
      "</channel>",
      `${xml.match(/<item>[\s\S]*?<\/item>/)![0]}</channel>`,
    );
    assert.equal((await collect(pool, "duplicate", duplicate)).valid_count, 3);
    assert.equal(
      (await pool.query("SELECT * FROM discoveries WHERE run_id = 'duplicate'"))
        .rowCount,
      2,
    );
    // A database failure halfway through must roll back publications and the run.
    await pool.query(
      "CREATE FUNCTION reject_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected storage failure'; END $$",
    );
    await pool.query(
      "CREATE TRIGGER reject_candidate BEFORE INSERT ON candidates FOR EACH ROW EXECUTE FUNCTION reject_candidate()",
    );
    const beforeFailure = await snapshot();
    await assert.rejects(
      collect(
        pool,
        "rollback",
        xml.replaceAll("fixture-de-1", "new-id").replaceAll("/wohnen", "/new"),
      ),
      /injected storage failure/,
    );
    assert.deepEqual(await snapshot(), beforeFailure);
    await pool.query("DROP TRIGGER reject_candidate ON candidates");
    await collect(
      pool,
      "html",
      xml.replace(
        "Öffentliche Anhörung: Wohnen &amp; Städte",
        "&lt;script&gt;alert(1)&lt;/script&gt;",
      ),
    );
    server = await startAdmin(env);
    try {
      const page = await (await fetch(`${server.url}/?run=html`)).text();
      assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.ok(!page.includes("<script>"));
    } finally {
      await server.stop();
    }
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
