import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalPageError } from "../src/dip/collect.js";
import {
  syncDipEndpoint,
  syncDipTerms,
  SYNC_OVERLAP_MS,
} from "../src/dip/sync.js";
import type { FetchStepPage } from "../src/dip/steps.js";
import { collectVorgang } from "../src/dip/vorgang.js";
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

test("transient page failures retry with bounded attempts then complete", async () => {
  const prisma = await isolatedDatabase();
  let calls = 0;
  const delays: number[] = [];
  const result = await collectVorgang(prisma, {
    runId: "dip-retry-1",
    electoralTerm: 21,
    retryDelayMs: (attempt) => {
      delays.push(attempt);
      return 0;
    },
    fetchPage: async (params) => {
      calls += 1;
      if (calls <= 2) throw new Error("flaky network");
      if (params.cursor === undefined)
        return {
          documents: [proceeding("1", "2026-10-10T10:00:00+02:00")],
          cursor: "c2",
          numFound: 0,
        };
      return { documents: [], cursor: "c2", numFound: 0 };
    },
  });
  assert.equal(result.versionsAdded, 1);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [1, 2]);
  await prisma.$disconnect();
});

test("terminal page errors fail without retrying", async () => {
  const prisma = await isolatedDatabase();
  let calls = 0;
  await assert.rejects(
    collectVorgang(prisma, {
      runId: "dip-retry-terminal",
      electoralTerm: 21,
      retryDelayMs: () => 0,
      fetchPage: async () => {
        calls += 1;
        throw new TerminalPageError("DIP /vorgang responded 400");
      },
    }),
    /responded 400/,
  );
  assert.equal(calls, 1);
  assert.equal(await prisma.dipCheckpoint.count(), 0);
  await prisma.$disconnect();
});

test("mid-pagination failure restarts the window once without duplicating records", async () => {
  const prisma = await isolatedDatabase();
  let startCount = 0;
  let c2Calls = 0;
  let c2Failed = false;
  const result = await collectVorgang(prisma, {
    runId: "dip-restart-1",
    electoralTerm: 21,
    retryDelayMs: () => 0,
    fetchPage: async (params) => {
      if (params.cursor === undefined) {
        startCount += 1;
        return {
          documents: [
            proceeding("1", "2026-10-10T10:00:00+02:00"),
            proceeding("2", "2026-10-10T11:00:00+02:00"),
          ],
          cursor: "c2",
          numFound: 0,
        };
      }
      c2Calls += 1;
      if (!c2Failed) {
        c2Failed = true;
        throw new TerminalPageError("DIP /vorgang responded 400");
      }
      return { documents: [], cursor: "c2", numFound: 0 };
    },
  });
  assert.equal(result.versionsAdded, 2);
  // One restart: the first page is fetched twice, the dead cursor once more.
  assert.equal(startCount, 2);
  assert.equal(c2Calls, 2);
  assert.equal(await prisma.proceeding.count(), 2);
  assert.equal(await prisma.proceedingVersion.count(), 2);
  assert.ok(
    await prisma.dipCheckpoint.findUnique({
      where: {
        endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
      },
    }),
  );
  await prisma.$disconnect();
});

test("checkpoints never move backward for older windows", async () => {
  const prisma = await isolatedDatabase();
  const newer = new Date("2026-10-12T07:00:00+02:00");
  await prisma.dipCheckpoint.create({
    data: { endpoint: "/vorgang", electoralTerm: 21, updatedThrough: newer },
  });
  const result = await collectVorgang(prisma, {
    runId: "dip-noregress-1",
    electoralTerm: 21,
    updatedFrom: new Date("2026-10-01T00:00:00+02:00"),
    updatedTo: new Date("2026-10-02T00:00:00+02:00"),
    fetchPage: async (params) => ({
      documents: [],
      cursor: params.cursor ?? "c2",
      numFound: 0,
    }),
  });
  assert.equal(result.status, "completed");
  const checkpoint = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
  });
  assert.deepEqual(checkpoint.updatedThrough, newer);
  await prisma.$disconnect();
});

test("concurrent same-scope runs stay idempotent with a forward checkpoint", async () => {
  const prisma = await isolatedDatabase();
  const fetchPage: FetchVorgangPage = async (params) => {
    if (params.cursor === undefined)
      return {
        documents: [proceeding("1", "2026-10-10T10:00:00+02:00")],
        cursor: "c2",
        numFound: 0,
      };
    return { documents: [], cursor: "c2", numFound: 0 };
  };
  const now1 = new Date("2026-10-11T07:00:00+02:00");
  const now2 = new Date("2026-10-11T08:00:00+02:00");
  const [first, second] = await Promise.all([
    syncDipEndpoint(prisma, "/vorgang", {
      runId: "dip-conc-1",
      electoralTerm: 21,
      now: now1,
      fetchPage,
    }),
    syncDipEndpoint(prisma, "/vorgang", {
      runId: "dip-conc-2",
      electoralTerm: 21,
      now: now2,
      fetchPage,
    }),
  ]);
  assert.equal(first.result.status, "completed");
  assert.equal(second.result.status, "completed");
  assert.equal(await prisma.proceeding.count(), 1);
  assert.equal(await prisma.proceedingVersion.count(), 1);
  const checkpoint = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
  });
  assert.deepEqual(checkpoint.updatedThrough, now2);
  await prisma.$disconnect();
});

test("bootstrap baseline hands off to incremental scans without losing updates", async () => {
  const prisma = await isolatedDatabase();
  const first = await syncDipEndpoint(prisma, "/vorgang", {
    runId: "dip-hand-1",
    electoralTerm: 21,
    now: new Date("2026-10-10T12:00:00+02:00"),
    fetchPage: async (params) =>
      params.cursor === undefined
        ? {
            documents: [proceeding("1", "2026-10-10T10:00:00+02:00")],
            cursor: "c2",
            numFound: 0,
          }
        : { documents: [], cursor: "c2", numFound: 0 },
  });
  assert.equal(first.result.versionsAdded, 1);
  const second = await syncDipEndpoint(prisma, "/vorgang", {
    runId: "dip-hand-2",
    electoralTerm: 21,
    now: new Date("2026-10-11T07:00:00+02:00"),
    fetchPage: async (params) =>
      params.cursor === undefined
        ? {
            documents: [
              {
                ...proceeding("1", "2026-10-10T18:00:00+02:00"),
                titel: "Neuer Titel",
              },
            ],
            cursor: "c2",
            numFound: 0,
          }
        : { documents: [], cursor: "c2", numFound: 0 },
  });
  assert.equal(second.result.versionsAdded, 1);
  const stored = await prisma.proceeding.findUniqueOrThrow({
    where: { apiId: "1" },
  });
  assert.equal(stored.latestVersionNo, 2);
  assert.equal(stored.title, "Neuer Titel");
  await prisma.$disconnect();
});
