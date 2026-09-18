import { readFile } from "node:fs/promises";
import pg from "pg";

export function database() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  pool.on("error", (error) =>
    console.error("Idle PostgreSQL connection failed:", error.message),
  );
  return pool;
}

export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(8135420)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY)",
    );
    const existing = await client.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      ["001_collection"],
    );
    if (!existing.rowCount) {
      await client.query(
        await readFile("migrations/001_collection.sql", "utf8"),
      );
      await client.query("INSERT INTO schema_migrations VALUES ($1)", [
        "001_collection",
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
