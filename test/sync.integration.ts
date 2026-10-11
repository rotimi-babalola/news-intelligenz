import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalPageError } from "../src/dip/collect.js";
import { collectAll } from "../src/import/service.js";
import type { Feed } from "../src/sources.js";
import { listDipGaps } from "../src/dip/repository.js";
import {
  syncDipEndpoint,
  syncDipTerms,
  SYNC_OVERLAP_MS,
} from "../src/dip/sync.js";
import type { FetchStepPage } from "../src/dip/steps.js";
import { collectSteps } from "../src/dip/steps.js";
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

test("operator backfill replays an older window without moving the checkpoint", async () => {
  const prisma = await isolatedDatabase();
  const progress = new Date("2026-10-12T07:00:00+02:00");
  await syncDipEndpoint(prisma, "/vorgang", {
    runId: "dip-backfill-base",
    electoralTerm: 21,
    now: progress,
    fetchPage: async (params) =>
      params.cursor === undefined
        ? {
            documents: [proceeding("1", "2026-10-11T10:00:00+02:00")],
            cursor: "c2",
            numFound: 0,
          }
        : { documents: [], cursor: "c2", numFound: 0 },
  });
  const seen: Parameters<FetchVorgangPage>[0][] = [];
  const start = new Date("2026-10-01T00:00:00+02:00");
  const end = new Date("2026-10-02T00:00:00+02:00");
  const backfill = await syncDipEndpoint(prisma, "/vorgang", {
    runId: "dip-backfill-1",
    electoralTerm: 21,
    window: { start, end },
    fetchPage: async (params) => {
      seen.push(params);
      return params.cursor === undefined
        ? {
            documents: [
              {
                ...proceeding("1", "2026-10-01T10:00:00+02:00"),
                titel: "Korrigierter Titel",
              },
            ],
            cursor: "c2",
            numFound: 0,
          }
        : { documents: [], cursor: "c2", numFound: 0 };
    },
  });
  // The operator window is used verbatim and its correction is stored, while
  // successful progress stays at the newer checkpoint.
  assert.equal(seen[0]?.aktualisiertStart, start.toISOString());
  assert.equal(seen[0]?.aktualisiertEnd, end.toISOString());
  assert.equal(backfill.result.versionsAdded, 1);
  const checkpoint = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
  });
  assert.deepEqual(checkpoint.updatedThrough, progress);
  await prisma.$disconnect();
});

test("failed scopes stay listed as gaps with window and error", async () => {
  const prisma = await isolatedDatabase();
  const now = new Date("2026-10-11T07:00:00+02:00");
  await assert.rejects(
    syncDipEndpoint(prisma, "/vorgang", {
      runId: "dip-gap-1",
      electoralTerm: 21,
      now,
      retryDelayMs: () => 0,
      fetchPage: async () => {
        throw new Error("DIP /vorgang responded 503");
      },
    }),
    /responded 503/,
  );
  const gaps = await listDipGaps(prisma);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.runId, "dip-gap-1");
  assert.equal(gaps[0]?.endpoint, "/vorgang");
  assert.equal(gaps[0]?.electoralTerm, 21);
  assert.equal(gaps[0]?.windowStart, null);
  assert.equal(gaps[0]?.windowEnd?.toISOString(), now.toISOString());
  assert.match(gaps[0]?.error ?? "", /responded 503/);
  await prisma.$disconnect();
});

test("absent records and unexplained 404s never delete retained state", async () => {
  const prisma = await isolatedDatabase();
  await syncDipEndpoint(prisma, "/vorgang", {
    runId: "dip-nodelete-1",
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
  // An incremental window that no longer contains the record completes while
  // the retained proceeding and its version stay intact.
  const swept = await syncDipEndpoint(prisma, "/vorgang", {
    runId: "dip-nodelete-2",
    electoralTerm: 21,
    now: new Date("2026-10-11T07:00:00+02:00"),
    fetchPage: async (params) => ({
      documents: [],
      cursor: params.cursor ?? "c2",
      numFound: 0,
    }),
  });
  assert.equal(swept.result.status, "completed");
  assert.ok(await prisma.proceeding.findUnique({ where: { apiId: "1" } }));
  assert.equal(
    await prisma.proceedingVersion.count({ where: { proceedingApiId: "1" } }),
    1,
  );
  // A step whose parent answers 404 is retained with its unresolved parent
  // instead of discarded.
  const steps = await collectSteps(prisma, {
    runId: "dip-nodelete-steps",
    electoralTerm: 21,
    followStoredParents: true,
    fetchPage: async (params) => ({
      documents:
        params.cursor === undefined
          ? [
              {
                id: "701499",
                typ: "Vorgangsposition",
                vorgangsposition: "Kleine Anfrage",
                zuordnung: "BT",
                gang: false,
                fortsetzung: false,
                nachtrag: false,
                vorgangstyp: "Kleine Anfrage",
                titel: "Titel 999999",
                dokumentart: "Drucksache",
                vorgang_id: "999999",
                datum: "2026-10-09",
                aktualisiert: "2026-10-09T13:24:22+02:00",
                fundstelle: {
                  id: "29701499",
                  dokumentnummer: "21/1001",
                  datum: "2026-10-09",
                  pdf_url:
                    "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
                },
                aktivitaet_anzahl: 0,
              },
            ]
          : [],
      cursor: params.cursor ?? "s2",
      numFound: 0,
    }),
    fetchVorgang: async () => null,
  });
  assert.equal(steps.stored, 1);
  const retained = await prisma.proceedingStep.findUniqueOrThrow({
    where: { apiId: "701499" },
  });
  assert.equal(retained.proceedingApiId, "999999");
  assert.equal(await prisma.proceeding.count(), 1);
  await prisma.$disconnect();
});

function proceedingStep(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    typ: "Vorgangsposition",
    vorgangsposition: "Kleine Anfrage",
    zuordnung: "BT",
    gang: false,
    fortsetzung: false,
    nachtrag: false,
    vorgangstyp: "Kleine Anfrage",
    titel: `Titel ${id}`,
    dokumentart: "Drucksache",
    vorgang_id: "340161",
    datum: "2026-10-09",
    aktualisiert: "2026-10-09T13:24:22+02:00",
    fundstelle: {
      id: "29701499",
      dokumentnummer: "21/1001",
      datum: "2026-10-09",
      pdf_url: "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
    },
    aktivitaet_anzahl: 0,
    ...overrides,
  };
}

test("step updates are found while the parent proceeding is unchanged", async () => {
  const prisma = await isolatedDatabase();
  const parent = proceeding("340161", "2026-10-09T13:24:22+02:00");
  const onePage =
    (documents: unknown[]) =>
    async (params: {
      cursor?: string;
    }): Promise<{ documents: unknown[]; cursor: string; numFound: number }> =>
      params.cursor === undefined
        ? { documents, cursor: "next", numFound: 0 }
        : { documents: [], cursor: "next", numFound: 0 };
  await syncDipTerms(prisma, {
    terms: [21],
    runIdFor: (endpoint, term) => `dip-steponly-base-${endpoint}-${term}`,
    now: new Date("2026-10-10T12:00:00+02:00"),
    fetchVorgangPage: onePage([parent]),
    fetchStepPage: onePage([proceedingStep("701499")]),
  });
  const outcome = await syncDipTerms(prisma, {
    terms: [21],
    runIdFor: (endpoint, term) => `dip-steponly-incr-${endpoint}-${term}`,
    now: new Date("2026-10-11T07:00:00+02:00"),
    fetchVorgangPage: onePage([parent]),
    fetchStepPage: onePage([
      proceedingStep("701499", {
        titel: "Aktualisierter Titel",
        aktualisiert: "2026-10-10T18:00:00+02:00",
      }),
    ]),
  });
  assert.equal(outcome.failed.length, 0);
  const vorgangScope = outcome.completed.find((c) => c.endpoint === "/vorgang");
  const stepsScope = outcome.completed.find(
    (c) => c.endpoint === "/vorgangsposition",
  );
  assert.equal(vorgangScope?.result.versionsAdded, 0);
  assert.equal(stepsScope?.result.versionsAdded, 1);
  await prisma.$disconnect();
});

test("a DIP scope failure coexists with successful public-news collection", async () => {
  const prisma = await isolatedDatabase();
  const feeds: Feed[] = [
    {
      id: "feed-a",
      publisher: "Deutschlandfunk",
      url: "https://example.org/a.rss",
      defaultLanguage: "de",
    },
  ];
  const results = await collectAll(
    prisma,
    "mix",
    async () =>
      `<rss><channel><language>de</language>` +
      `<item><title>Headline</title>` +
      `<link>https://www.deutschlandfunk.de/x.html</link>` +
      `<guid>x</guid>` +
      `<pubDate>Tue, 22 Sep 2026 08:00:00 +0200</pubDate></item>` +
      `</channel></rss>`,
    feeds,
    async () => ({
      ok: false as const,
      reason: "Unsupported format: test stub holds no article",
    }),
  );
  assert.equal(results[0]?.status, "completed");
  await assert.rejects(
    syncDipEndpoint(prisma, "/vorgangsposition", {
      runId: "dip-mix-1",
      electoralTerm: 21,
      now: new Date("2026-10-11T07:00:00+02:00"),
      retryDelayMs: () => 0,
      fetchPage: async () => {
        throw new Error("DIP /vorgangsposition responded 503");
      },
    }),
    /responded 503/,
  );
  // Both outcomes stay inspectable side by side for the #8 scheduler seam.
  assert.equal(
    (await prisma.run.findUniqueOrThrow({ where: { id: "mix:feed-a" } }))
      .status,
    "completed",
  );
  assert.equal(
    (await prisma.run.findUniqueOrThrow({ where: { id: "dip-mix-1" } })).status,
    "failed",
  );
  assert.ok(
    (await listDipGaps(prisma)).some((gap) => gap.runId === "dip-mix-1"),
  );
  await prisma.$disconnect();
});

test("local proceeding cap applies through multi-term sync", async () => {
  const prisma = await isolatedDatabase();
  const outcome = await syncDipTerms(prisma, {
    terms: [21],
    endpoints: ["/vorgang"],
    runIdFor: (endpoint, term) => `dip-cap-${endpoint}-${term}`,
    now: new Date("2026-10-11T07:00:00+02:00"),
    proceedingCap: 1,
    fetchVorgangPage: async (params) =>
      params.cursor === undefined
        ? {
            documents: [
              proceeding("1", "2026-10-10T10:00:00+02:00"),
              proceeding("2", "2026-10-10T11:00:00+02:00"),
            ],
            cursor: "c2",
            numFound: 0,
          }
        : { documents: [], cursor: "c2", numFound: 0 },
    fetchStepPage: async (params) => ({
      documents: [],
      cursor: params.cursor ?? "s2",
      numFound: 0,
    }),
  });
  assert.equal(outcome.failed.length, 0);
  assert.equal(outcome.completed[0]?.result.stored, 1);
  assert.equal(outcome.completed[0]?.result.capped, 1);
  await prisma.$disconnect();
});
