import { database } from "../src/db.js";
import { berlinHour, parseElectoralTerms } from "../src/dip/schedule.js";
import { liveStepsFetcher } from "../src/dip/steps.js";
import { syncDipTerms } from "../src/dip/sync.js";
import { liveVorgangFetcher } from "../src/dip/vorgang.js";

// Daily DIP collection for the Render cron, e.g.
// node dist/scripts/run-dip.js
// Collection only: PDF fetching and embedding are separate drains, so this
// needs neither Python nor Ollama. A failed scope exits non-zero, and its
// checkpoint stays put so the next run's overlap window retries it.
const now = new Date();
const dueHour = process.env.DIP_RUN_HOUR?.trim();
if (dueHour && berlinHour(now) !== Number(dueHour)) {
  console.log(
    `not due: ${berlinHour(now)}:00 Europe/Berlin, waiting for ${dueHour}:00`,
  );
  process.exit(0);
}

const terms = parseElectoralTerms(process.env.DIP_ELECTORAL_TERMS);
const runId =
  process.env.DIP_RUN_ID?.trim() || `dip-${now.toISOString().slice(0, 10)}`;
const apiKey = process.env.BUNDESTAG_API_KEY;
if (!apiKey) throw new Error("BUNDESTAG_API_KEY is not configured");

const prisma = database();
try {
  const steps = liveStepsFetcher(apiKey);
  const outcome = await syncDipTerms(prisma, {
    terms,
    runIdFor: (endpoint, term) => `${runId}:${endpoint}:${term}`,
    now,
    fetchVorgangPage: liveVorgangFetcher(apiKey),
    fetchStepPage: steps.fetchPage,
    fetchVorgang: steps.fetchVorgang,
  });
  for (const scope of outcome.completed) {
    const result = scope.result;
    console.log(
      `${scope.electoralTerm} ${scope.endpoint}: valid=${result.valid} invalid=${result.invalid} stored=${result.stored} versions=${result.versionsAdded} capped=${result.capped}`,
    );
  }
  for (const failure of outcome.failed) {
    console.error(
      `${failure.electoralTerm} ${failure.endpoint}: ${failure.error}`,
    );
  }
  if (outcome.failed.length) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
