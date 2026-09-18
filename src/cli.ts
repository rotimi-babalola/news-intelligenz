import { readFile } from "node:fs/promises";
import { collect } from "./collect.js";
import { database, migrate } from "./db.js";

const [command, runId] = process.argv.slice(2);
if (command !== "migrate" && (command !== "collect" || !runId)) {
  console.error(
    "Usage: cli migrate | collect <run-id> (synthetic fixture only)",
  );
  process.exitCode = 1;
} else {
  const pool = database();
  try {
    await migrate(pool);
    if (command === "collect") {
      const result = await collect(
        pool,
        runId!,
        await readFile("fixtures/bundestag.xml", "utf8"),
      );
      console.log(JSON.stringify(result));
      if (result.status === "failed") process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Operation failed");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
