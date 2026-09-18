import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { collect } from "../src/collect.js";
import { database, migrate } from "../src/db.js";

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
    const first = await collect(pool, "first", xml);
    assert.equal(first.valid_count, 2);
    assert.equal(first.invalid_count, 1);
    assert.deepEqual(await collect(pool, "first", xml), first);
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
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
