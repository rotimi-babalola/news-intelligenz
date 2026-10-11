import assert from "node:assert/strict";
import { test } from "node:test";
import { collectVorgang, type FetchVorgangPage } from "../src/dip/vorgang.js";
import { isolatedDatabase } from "./dip-test-db.js";

function doc(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    typ: "Vorgang",
    vorgangstyp: "Kleine Anfrage",
    wahlperiode: 21,
    titel: `Titel ${id}`,
    aktualisiert: "2026-10-09T13:24:22+02:00",
    ...overrides,
  };
}

// Serves canned pages keyed by cursor and records every call so tests can
// assert filters stay unchanged across pagination.
function fakeFetcher(
  pages: Record<string, { documents: unknown[]; next: string }>,
) {
  const calls: Parameters<FetchVorgangPage>[0][] = [];
  const fetchPage: FetchVorgangPage = async (params) => {
    calls.push(params);
    const key = params.cursor ?? "start";
    const page = pages[key];
    if (!page) throw new Error(`unexpected cursor ${key}`);
    return { documents: page.documents, cursor: page.next, numFound: 0 };
  };
  return { fetchPage, calls };
}

test("multi-page import stores records once and advances the checkpoint", async () => {
  const prisma = await isolatedDatabase();
  const { fetchPage, calls } = fakeFetcher({
    start: { documents: [doc("1"), doc("2")], next: "c2" },
    c2: { documents: [doc("3")], next: "c2" },
  });
  const result = await collectVorgang(prisma, {
    runId: "dip-vorgang-1",
    electoralTerm: 21,
    fetchPage,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(
    { valid: result.valid, invalid: result.invalid, stored: result.stored },
    { valid: 3, invalid: 0, stored: 3 },
  );
  assert.equal(result.versionsAdded, 3);
  assert.equal(await prisma.proceeding.count(), 3);
  assert.equal(await prisma.proceedingVersion.count(), 3);
  assert.equal(
    await prisma.parliamentaryDiscovery.count({
      where: { runId: "dip-vorgang-1" },
    }),
    3,
  );
  // Filters repeat unchanged; only the cursor moves, and import ends when the
  // cursor stops changing.
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.wahlperiode === 21));
  assert.equal(calls[1]?.cursor, "c2");
  const indexes = await prisma.candidate.findMany({
    where: { runId: "dip-vorgang-1" },
    orderBy: { itemIndex: "asc" },
  });
  assert.deepEqual(
    indexes.map((c) => c.itemIndex),
    [0, 1, 2],
  );
  const checkpoint = await prisma.dipCheckpoint.findUniqueOrThrow({
    where: {
      endpoint_electoralTerm: { endpoint: "/vorgang", electoralTerm: 21 },
    },
  });
  assert.ok(checkpoint.updatedThrough instanceof Date);
  await prisma.$disconnect();
});

test("replay adds no versions; changed text adds one; restored text adds another", async () => {
  const prisma = await isolatedDatabase();
  const one = await collectVorgang(prisma, {
    runId: "dip-vorgang-replay",
    electoralTerm: 21,
    fetchPage: fakeFetcher({
      start: { documents: [doc("1")], next: "x" },
      x: { documents: [], next: "x" },
    }).fetchPage,
  });
  assert.equal(one.versionsAdded, 1);

  const replay = await collectVorgang(prisma, {
    runId: "dip-vorgang-replay",
    electoralTerm: 21,
    fetchPage: async () => {
      throw new Error("replayed runs must not refetch");
    },
  });
  assert.equal(replay.replayed, true);
  assert.equal(await prisma.proceedingVersion.count(), 1);

  const changed = await collectVorgang(prisma, {
    runId: "dip-vorgang-changed",
    electoralTerm: 21,
    fetchPage: fakeFetcher({
      start: { documents: [doc("1", { titel: "Neuer Titel" })], next: "x" },
      x: { documents: [], next: "x" },
    }).fetchPage,
  });
  assert.equal(changed.versionsAdded, 1);
  assert.equal(
    (await prisma.proceeding.findUniqueOrThrow({ where: { apiId: "1" } }))
      .title,
    "Neuer Titel",
  );

  const restored = await collectVorgang(prisma, {
    runId: "dip-vorgang-restored",
    electoralTerm: 21,
    fetchPage: fakeFetcher({
      start: { documents: [doc("1")], next: "x" },
      x: { documents: [], next: "x" },
    }).fetchPage,
  });
  assert.equal(restored.versionsAdded, 1);
  assert.equal(await prisma.proceedingVersion.count(), 3);
  await prisma.$disconnect();
});

test("invalid documents stay inspectable and failed runs keep the checkpoint shut", async () => {
  const prisma = await isolatedDatabase();
  let attempts = 0;
  const flaky: FetchVorgangPage = async ({ cursor }) => {
    attempts += 1;
    if (!cursor) return { documents: [doc("1")], cursor: "c2", numFound: 0 };
    throw new Error("page lost");
  };
  await assert.rejects(
    collectVorgang(prisma, {
      runId: "dip-vorgang-flaky",
      electoralTerm: 21,
      fetchPage: flaky,
    }),
    /page lost/,
  );
  assert.equal(
    (await prisma.run.findUniqueOrThrow({ where: { id: "dip-vorgang-flaky" } }))
      .status,
    "failed",
  );
  assert.equal(await prisma.dipCheckpoint.count(), 0);

  // Resume with the same run ID: no duplicates, checkpoint advances.
  const resumed = await collectVorgang(prisma, {
    runId: "dip-vorgang-flaky",
    electoralTerm: 21,
    fetchPage: fakeFetcher({
      start: { documents: [doc("1"), { id: "9", typ: "Vorgang" }], next: "c2" },
      c2: { documents: [], next: "c2" },
    }).fetchPage,
  });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(
    { valid: resumed.valid, invalid: resumed.invalid },
    { valid: 1, invalid: 1 },
  );
  assert.equal(await prisma.proceeding.count(), 1);
  assert.equal(await prisma.dipCheckpoint.count(), 1);
  const bad = await prisma.candidate.findFirstOrThrow({
    where: { runId: "dip-vorgang-flaky", itemIndex: 1 },
  });
  assert.ok((bad.errors as unknown[]).length > 0);
  assert.equal(attempts, 2);
  await prisma.$disconnect();
});

test("concurrent same-run imports converge without duplicates", async () => {
  const prisma = await isolatedDatabase();
  const { fetchPage } = fakeFetcher({
    start: { documents: [doc("1"), doc("2")], next: "c2" },
    c2: { documents: [], next: "c2" },
  });
  const options = { runId: "dip-vorgang-race", electoralTerm: 21, fetchPage };
  const [a, b] = await Promise.all([
    collectVorgang(prisma, options),
    collectVorgang(prisma, options),
  ]);
  assert.equal(a.status, "completed");
  assert.equal(b.status, "completed");
  assert.equal(await prisma.proceeding.count(), 2);
  assert.equal(await prisma.proceedingVersion.count(), 2);
  assert.equal(
    await prisma.parliamentaryDiscovery.count({
      where: { runId: "dip-vorgang-race" },
    }),
    2,
  );
  await prisma.$disconnect();
});

test("local cap keeps the first records encountered and keeps syncing them", async () => {
  const prisma = await isolatedDatabase();
  const pages = () =>
    fakeFetcher({
      start: { documents: [doc("1"), doc("2")], next: "c2" },
      c2: { documents: [doc("3")], next: "c2" },
    }).fetchPage;
  const first = await collectVorgang(prisma, {
    runId: "dip-vorgang-cap-1",
    electoralTerm: 21,
    proceedingCap: 2,
    fetchPage: pages(),
  });
  assert.deepEqual(
    { stored: first.stored, capped: first.capped },
    { stored: 2, capped: 1 },
  );
  assert.equal(await prisma.proceeding.count(), 2);

  // Across runs the cap still holds, but stored records keep syncing.
  const second = await collectVorgang(prisma, {
    runId: "dip-vorgang-cap-2",
    electoralTerm: 21,
    proceedingCap: 2,
    fetchPage: fakeFetcher({
      start: {
        documents: [doc("1", { titel: "Aktualisiert" }), doc("4")],
        next: "x",
      },
      x: { documents: [], next: "x" },
    }).fetchPage,
  });
  assert.deepEqual(
    { stored: second.stored, capped: second.capped },
    { stored: 1, capped: 1 },
  );
  assert.equal(second.versionsAdded, 1);
  assert.equal(await prisma.proceeding.count(), 2);
  assert.equal(
    (await prisma.proceeding.findUniqueOrThrow({ where: { apiId: "1" } }))
      .title,
    "Aktualisiert",
  );
  await prisma.$disconnect();
});
