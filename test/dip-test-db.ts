import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after } from "node:test";
import pg from "pg";

const root = process.cwd();
const schemas: { baseUrl: string; name: string }[] = [];

after(async () => {
  for (const { baseUrl, name } of schemas) {
    const admin = new pg.Pool({ connectionString: baseUrl });
    try {
      await admin.query(`DROP SCHEMA ${name} CASCADE`);
    } finally {
      await admin.end();
    }
  }
});

// Each caller gets a fresh schema with all migrations applied; callers never
// share state, and rerunning a suite leaves no residue behind.
export async function isolatedDatabase() {
  const configured = new URL(process.env.DATABASE_URL!);
  configured.searchParams.delete("schema");
  const baseUrl = configured.toString();
  const admin = new pg.Pool({ connectionString: baseUrl });
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  schemas.push({ baseUrl, name: schema });
  const url = `${baseUrl}?schema=${schema}`;
  process.env.DATABASE_URL = url;
  const env = { ...process.env, DATABASE_URL: url };
  await promisify(execFile)("node_modules/.bin/prisma", ["migrate", "deploy"], {
    env,
    cwd: root,
  });
  const { database } = await import("../src/db.js");
  return database();
}
