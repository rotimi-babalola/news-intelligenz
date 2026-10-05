import { database } from "../src/db.js";
import { collectFixtureRun } from "../src/import/service.js";

// Seeds the local DB with fixtures/bundestag.xml (2 valid, 1 invalid).
// Usage: node --env-file-if-exists=.env dist/scripts/seed.js [runId]
const runId = process.argv[2] ?? "seed";
const prisma = database();
try {
  const run = await collectFixtureRun(prisma, runId);
  console.log(
    `seeded run ${run.id}: status=${run.status} valid=${run.validCount} invalid=${run.invalidCount}`,
  );
} finally {
  await prisma.$disconnect();
}
