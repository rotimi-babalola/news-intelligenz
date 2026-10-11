import assert from "node:assert/strict";
import { test } from "node:test";
import { syncDipEndpoint } from "../src/dip/sync.js";
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
    new Date(now1.getTime() - 6 * 60 * 60 * 1000).toISOString(),
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
