import assert from "node:assert/strict";
import { test } from "node:test";
import { syncDipEndpoint, syncDipTerms, SYNC_OVERLAP_MS } from "../src/dip/sync.js";
import type { FetchStepPage } from "../src/dip/steps.js";
import type { FetchVorgangPage } from "../src/dip/vorgang.js";
import { isolatedDatabase } from "./dip-test-db.js";

function proceeding(id: string, aktualisiert: string) {
  return {
    id,
    typ: "Vorgang",
    vorgangstyp: "Kleine Anfrage",
    wahlperiode: 21,
    titel: `Titel ${id}`,
    aktualisiert,
  };
}

test("sync uses baseline then overlap windows and holds checkpoint on failure", async () => {
  const prisma = await isolatedDatabase();
  const seen: Parameters<FetchVorgangPage>[0][] = [];
  const fetchPage: FetchVorgangPage = async (params) => {
    seen.push(params);
    return {
      documents: [proceeding("1", "2026-10-10T10:00:00+02:00")],
      cursor: params.cursor ?? "c2",
      numFound: 0,
    };
  };

  // Baseline: no start filter, fixed end.
  const now1 = new Date("2026-10-10T12:00:00+02:00");
  const first = await syncDipEndpoint(prisma, "/vorgang", {
    runId: "dip-sync-1",
    electoralTerm: 21,
    now: now1,
    fetchPage,
  });
  assert.equal(first.window.start, undefined);
  assert.deepEqual(first.window.end, now1);
  assert.equal(seen[0]?.aktualisiertStart, undefined);
  assert.equal(seen[0]?.aktualisiertEnd, now1.toISOString());
  const checkpoint1 = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
  });
  assert.deepEqual(checkpoint1.updatedThrough, now1);

  // Incremental: start is six hours before successful progress.
  seen.length = 0;
  const now2 = new Date("2026-10-11T07:00:00+02:00");
  await syncDipEndpoint(prisma, "/vorgang", {
    runId: "dip-sync-2",
    electoralTerm: 21,
    now: now2,
    fetchPage,
  });
  assert.equal(
    seen[0]?.aktualisiertStart,
    new Date(now1.getTime() - SYNC_OVERLAP_MS).toISOString(),
  );
  assert.equal(seen[0]?.aktualisiertEnd, now2.toISOString());
  // Filters repeat unchanged while only the cursor moves.
  assert.ok(
    seen.every(
      (call) =>
        call.aktualisiertStart === seen[0]?.aktualisiertStart &&
        call.aktualisiertEnd === seen[0]?.aktualisiertEnd,
    ),
  );

  // Mid-pagination failure leaves the checkpoint at the last success.
  const before = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
  });
  await assert.rejects(
    syncDipEndpoint(prisma, "/vorgang", {
      runId: "dip-sync-fail",
      electoralTerm: 21,
      now: new Date("2026-10-12T07:00:00+02:00"),
      fetchPage: async () => {
        throw new Error("page fetch failed");
      },
    }),
    /page fetch failed/,
  );
  const after = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
  });
  assert.deepEqual(after, before);
  await prisma.$disconnect();
});

test("multi-term sync baselines new terms and isolates sibling failures", async () => {
  const prisma = await isolatedDatabase();
  // Term 20 has prior progress; term 21 is newly added and gets a baseline.
  const prior = new Date("2026-10-10T12:00:00+02:00");
  await prisma.dipCheckpoint.create({
    data: {
      endpoint: "/vorgang",
      electoralTerm: 20,
      updatedThrough: prior,
    },
  });
  const seenVorgang: Parameters<FetchVorgangPage>[0][] = [];
  const fetchVorgangPage: FetchVorgangPage = async (params) => {
    seenVorgang.push(params);
    if (params.wahlperiode === 21) throw new Error("baseline fetch failed");
    return { documents: [], cursor: params.cursor ?? "c2", numFound: 0 };
  };
  const fetchStepPage: FetchStepPage = async (params) => ({
    documents: [],
    cursor: params.cursor ?? "s2",
    numFound: 0,
  });

  const outcome = await syncDipTerms(prisma, {
    terms: [20, 21, 20],
    endpoints: ["/vorgang"],
    runIdFor: (endpoint, term) => `dip-terms-${endpoint}-${term}`,
    now: new Date("2026-10-11T07:00:00+02:00"),
    fetchVorgangPage,
    fetchStepPage,
  });

  // Duplicate term runs once; term 20 completes, term 21 reports its failure
  // without blocking its sibling.
  assert.equal(outcome.completed.length, 1);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.completed[0]?.electoralTerm, 20);
  assert.equal(outcome.failed[0]?.electoralTerm, 21);
  assert.match(outcome.failed[0]?.error ?? "", /baseline fetch failed/);
  // Previously seen term resumes with overlap; the new term attempted no
  // start filter before failing.
  const term20 = seenVorgang.find((call) => call.wahlperiode === 20);
  assert.equal(
    term20?.aktualisiertStart,
    new Date(prior.getTime() - SYNC_OVERLAP_MS).toISOString(),
  );
  const term21 = seenVorgang.find((call) => call.wahlperiode === 21);
  assert.equal(term21?.aktualisiertStart, undefined);
  // No historical terms beyond the explicit list are touched.
  assert.deepEqual(
    [...new Set(seenVorgang.map((call) => call.wahlperiode))].sort(),
    [20, 21],
  );
  await prisma.$disconnect();
});
