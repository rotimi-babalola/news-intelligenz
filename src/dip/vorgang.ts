import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { createRun, finalizeRun, findRun } from "../import/run.repository";
import { runIdSchema } from "../validation";
import {
  countProceedingsByTerm,
  createProceeding,
  createProceedingVersion,
  findProceeding,
  latestProceedingVersion,
  updateProceeding,
  upsertDipCandidate,
  upsertDipCheckpoint,
  upsertParliamentaryDiscovery,
} from "./repository";
import type {
  CollectVorgangOptions,
  CollectVorgangResult,
  FetchVorgangPage,
  StoredDoc,
} from "./types";
import {
  contentHash,
  isUniqueViolation,
  scopeInputHash,
  toStored,
} from "./util";

export type {
  CollectVorgangOptions,
  CollectVorgangResult,
  FetchVorgangPage,
  VorgangPage,
} from "./types";

// DIP /vorgang import. Collection state persists idempotently in PostgreSQL:
// rerunning a run reuses its rows, and the checkpoint advances only after all
// pages are durably stored. Embedding and PDF work (later slices) enqueue
// independently and never hold the checkpoint open.

export const VORGANG_ENDPOINT = "/vorgang";

// Local environments cap unique proceedings at the first 1,000 encountered
// through pagination and keep syncing those; other environments pass no cap.
// The API defines no ordering, so the capped set is not newest-first.
export const LOCAL_PROCEEDING_CAP = 1000;

// Shared with step collection for missing-parent backfill: stores one page of
// validated proceedings idempotently, honoring the local cap.
export async function storeProceedingPage(
  tx: Prisma.TransactionClient,
  runId: string,
  stored: StoredDoc[],
  cap: number | undefined,
) {
  let versionsAdded = 0;
  let capped = 0;
  // The page transaction holds the intake advisory lock, so one count per
  // term per page stays exact across concurrent same-run writers.
  const remainingByTerm = new Map<number, number>();
  for (const { doc, raw, index } of stored) {
    let remaining: number | null = null;
    if (cap !== undefined) {
      const cached = remainingByTerm.get(doc.wahlperiode);
      if (cached !== undefined) {
        remaining = cached;
      } else {
        const count = await countProceedingsByTerm(tx, doc.wahlperiode);
        remaining = Math.max(0, cap - count);
        remainingByTerm.set(doc.wahlperiode, remaining);
      }
    }
    const known = await findProceeding(tx, doc.id);
    if (!known && remaining === 0) {
      capped += 1;
      await upsertDipCandidate(
        tx,
        runId,
        index,
        { endpoint: VORGANG_ENDPOINT, id: doc.id },
        [],
      );
      continue;
    }
    const hash = contentHash(doc, raw);
    const sourceUpdatedAt = new Date(doc.aktualisiert);
    const documentDate = doc.datum ? new Date(doc.datum) : null;
    const data = {
      title: doc.titel,
      proceedingType: doc.vorgangstyp,
      electoralTerm: doc.wahlperiode,
      deliberationState: doc.beratungsstand ?? null,
      documentDate,
      sourceUpdatedAt,
      metadata: raw as Prisma.InputJsonValue,
      lastObservedAt: new Date(),
    };
    const latest = await latestProceedingVersion(tx, doc.id);
    if (!known) {
      await createProceeding(tx, {
        apiId: doc.id,
        ...data,
        latestVersionNo: 1,
      });
      if (remaining !== null)
        remainingByTerm.set(doc.wahlperiode, remaining - 1);
      await createProceedingVersion(tx, {
        proceedingApiId: doc.id,
        versionNo: 1,
        contentHash: hash,
        snapshot: { ...data, metadata: raw } as Prisma.InputJsonValue,
        sourceUpdatedAt,
        runId,
      });
      versionsAdded += 1;
    } else if (latest && latest.contentHash === hash) {
      await updateProceeding(tx, doc.id, data);
    } else {
      const versionNo = (latest?.versionNo ?? 0) + 1;
      try {
        await createProceedingVersion(tx, {
          proceedingApiId: doc.id,
          versionNo,
          contentHash: hash,
          snapshot: { ...data, metadata: raw } as Prisma.InputJsonValue,
          sourceUpdatedAt,
          runId,
        });
      } catch (error) {
        // A concurrent same-run writer stored this version first; reread and
        // reconcile instead of duplicating it.
        if (!isUniqueViolation(error)) throw error;
        const current = await latestProceedingVersion(tx, doc.id);
        if (!current || current.contentHash !== hash) throw error;
        await updateProceeding(tx, doc.id, data);
        continue;
      }
      await updateProceeding(tx, doc.id, {
        ...data,
        latestVersionNo: versionNo,
      });
      versionsAdded += 1;
    }
    await upsertDipCandidate(
      tx,
      runId,
      index,
      { endpoint: VORGANG_ENDPOINT, id: doc.id },
      [],
    );
    await upsertParliamentaryDiscovery(tx, runId, "vorgang", doc.id);
  }
  return { versionsAdded, capped };
}

export async function collectVorgang(
  prisma: PrismaClient,
  options: CollectVorgangOptions,
): Promise<CollectVorgangResult> {
  const runId = runIdSchema.parse(options.runId);
  const hash = scopeInputHash(VORGANG_ENDPOINT, options);
  const scope: Record<string, unknown> = {
    electoralTerm: options.electoralTerm,
  };
  if (options.updatedFrom)
    scope.aktualisiertStart = options.updatedFrom.toISOString();
  if (options.updatedTo)
    scope.aktualisiertEnd = options.updatedTo.toISOString();
  if (options.proceedingCap !== undefined)
    scope.proceedingCap = options.proceedingCap;

  const replayed = await prisma.$transaction(async (tx) => {
    // Serialize concurrent same-run imports; per-page work below stays small.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8135421)`;
    const previous = await findRun(tx, runId);
    if (previous) {
      if (previous.inputHash !== hash || previous.feedId !== VORGANG_ENDPOINT)
        throw new Error(
          "Run ID already belongs to a different input; use a new run ID",
        );
      if (previous.status === "completed" && previous.completedAt !== null)
        return previous;
    } else {
      await createRun(tx, {
        id: runId,
        feedId: VORGANG_ENDPOINT,
        sourceKind: "dip_endpoint",
        sourceScope: scope as Prisma.InputJsonValue,
        inputHash: hash,
        status: "running",
      });
    }
    return null;
  });
  if (replayed)
    return {
      runId,
      status: "completed",
      valid: replayed.validCount,
      invalid: replayed.invalidCount,
      stored: 0,
      versionsAdded: 0,
      capped: 0,
      replayed: true,
    };

  let cursor: string | undefined;
  let valid = 0;
  let invalid = 0;
  let stored = 0;
  let versionsAdded = 0;
  let capped = 0;
  let itemIndex = 0;
  let maxObserved: Date | null = null;
  try {
    for (;;) {
      const page = await options.fetchPage({
        wahlperiode: options.electoralTerm,
        aktualisiertStart: options.updatedFrom?.toISOString(),
        aktualisiertEnd: options.updatedTo?.toISOString(),
        cursor,
      });
      const storedDocs: StoredDoc[] = [];
      const invalidDocs: { index: number; error: string; id: string | null }[] =
        [];
      for (const input of page.documents) {
        const converted = toStored(input, itemIndex);
        itemIndex += 1;
        if ("error" in converted) {
          invalid += 1;
          invalidDocs.push({
            index: converted.index,
            error: converted.error,
            id:
              typeof input === "object" && input !== null && "id" in input
                ? String((input as Record<string, unknown>)["id"])
                : null,
          });
        } else {
          valid += 1;
          storedDocs.push(converted);
        }
      }
      const counts = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(8135421)`;
        for (const { index, error, id } of invalidDocs) {
          await upsertDipCandidate(
            tx,
            runId,
            index,
            { endpoint: VORGANG_ENDPOINT, id },
            [error],
          );
        }
        return storeProceedingPage(
          tx,
          runId,
          storedDocs,
          options.proceedingCap,
        );
      });
      versionsAdded += counts.versionsAdded;
      capped += counts.capped;
      stored += storedDocs.length - counts.capped;
      for (const { doc } of storedDocs) {
        const observed = new Date(doc.aktualisiert);
        if (!maxObserved || observed > maxObserved) maxObserved = observed;
      }
      // Pagination ends when the cursor stops changing.
      if (!page.cursor || page.cursor === cursor) break;
      cursor = page.cursor;
    }
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      await finalizeRun(tx, runId, {
        status: "failed",
        validCount: valid,
        invalidCount: invalid,
        completedAt: new Date(),
        error:
          error instanceof Error ? error.message.slice(0, 2000) : "unknown",
      });
    });
    throw error;
  }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8135421)`;
    await finalizeRun(tx, runId, {
      status: "completed",
      validCount: valid,
      invalidCount: invalid,
      completedAt: new Date(),
      error: null,
    });
    // Checkpoint advances only after all pages are durably stored.
    await upsertDipCheckpoint(
      tx,
      VORGANG_ENDPOINT,
      options.electoralTerm,
      options.updatedTo ?? maxObserved,
    );
  });
  return {
    runId,
    status: "completed",
    valid,
    invalid,
    stored,
    versionsAdded,
    capped,
    replayed: false,
  };
}

// Live page fetcher for operational use (tests inject fakes). Sends explicit
// timezone offsets; callers pass real Date objects, never bare local times.
export function liveVorgangFetcher(apiKey: string): FetchVorgangPage {
  return async ({
    wahlperiode,
    aktualisiertStart,
    aktualisiertEnd,
    cursor,
  }) => {
    // The API names its filters f.wahlperiode etc.; URLSearchParams encodes
    // the dots literally, which the endpoint accepts.
    const query = new URLSearchParams({ format: "json" });
    query.set("f.wahlperiode", String(wahlperiode));
    if (aktualisiertStart) query.set("f.aktualisiert.start", aktualisiertStart);
    if (aktualisiertEnd) query.set("f.aktualisiert.end", aktualisiertEnd);
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(
      `https://search.dip.bundestag.de/api/v1/vorgang?${query}`,
      { headers: { Authorization: `ApiKey ${apiKey}` } },
    );
    if (!response.ok)
      throw new Error(`DIP /vorgang responded ${response.status}`);
    const body = (await response.json()) as {
      documents?: unknown[];
      cursor?: string;
      numFound?: number;
    };
    if (!Array.isArray(body.documents) || typeof body.cursor !== "string")
      throw new Error("DIP /vorgang returned an unexpected payload");
    return {
      documents: body.documents,
      cursor: body.cursor,
      numFound: body.numFound ?? 0,
    };
  };
}
