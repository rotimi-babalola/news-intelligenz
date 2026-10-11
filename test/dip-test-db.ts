import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const root = process.cwd();

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
