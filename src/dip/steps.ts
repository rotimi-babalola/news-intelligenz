import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { createRun, finalizeRun, findRun } from "../import/run.repository";
import { runIdSchema } from "../validation";
import {
  createStep,
  createStepVersion,
  findProceeding,
  findStep,
  latestStepVersion,
  updateStep,
  upsertDipCandidate,
  upsertDipCheckpoint,
  upsertDocumentReference,
  upsertParliamentaryDiscovery,
} from "./repository";
import type {
  CollectStepsOptions,
  CollectStepsResult,
  StoredStep,
} from "./types";
import {
  isUniqueViolation,
  scopeInputHash,
  stepContentHash,
  toStored,
  toStoredStep,
} from "./util";
import { storeProceedingPage, VORGANG_ENDPOINT } from "./vorgang";

export type {
  CollectStepsOptions,
  CollectStepsResult,
  FetchStepPage,
  FetchVorgang,
  StepPage,
} from "./types";

// DIP /vorgangsposition import. Steps link to proceedings through vorgang_id;
// a step whose parent is not stored is retained either way — unresolved
// parents stay inspectable on the step row, never silently discarded. An
// optional single-item parent fetch backfills genuinely missing context, but
// independently fetched endpoints are not an atomic snapshot and complete
// lifecycle coverage is never claimed from term filters alone.

export const STEPS_ENDPOINT = "/vorgangsposition";

async function storeStepsPage(
  tx: Prisma.TransactionClient,
  runId: string,
  steps: StoredStep[],
  parent: {
    followStored: boolean;
    cap: number | undefined;
    fetchVorgang: CollectStepsOptions["fetchVorgang"];
  },
) {
  let versionsAdded = 0;
  let capped = 0;
  let backfilled = 0;
  // Backfilled parents never appeared in page order, so they take negative
  // candidate indexes that cannot collide with paged documents or each other.
  let backfillIndex = -1;
  for (const { doc, raw, fundstelleRest, index } of steps) {
    const candidateMeta = { endpoint: STEPS_ENDPOINT, id: doc.id };
    let skipForCap = false;
    if (parent.followStored && !(await findProceeding(tx, doc.vorgang_id))) {
      const fetched = await parent.fetchVorgang?.(doc.vorgang_id);
      const converted =
        fetched !== undefined && fetched !== null
          ? toStored(fetched, backfillIndex--)
          : null;
      if (converted && !("error" in converted)) {
        const outcome = await storeProceedingPage(
          tx,
          runId,
          [converted],
          parent.cap,
        );
        versionsAdded += outcome.versionsAdded;
        backfilled += 1;
        skipForCap = outcome.capped > 0;
      }
    }
    if (skipForCap) {
      capped += 1;
      await upsertDipCandidate(tx, runId, index, candidateMeta, []);
      continue;
    }
    const hash = stepContentHash(doc, raw);
    const sourceUpdatedAt = new Date(doc.aktualisiert);
    const documentDate = new Date(doc.datum);
    const data = {
      proceedingApiId: doc.vorgang_id,
      institution: doc.zuordnung,
      stepLabel: doc.vorgangsposition,
      title: doc.titel,
      documentType: doc.dokumentart,
      documentDate,
      sourceUpdatedAt,
      metadata: raw as Prisma.InputJsonValue,
      lastObservedAt: new Date(),
    };
    const known = await findStep(tx, doc.id);
    const latest = await latestStepVersion(tx, doc.id);
    if (!known) {
      await createStep(tx, { apiId: doc.id, ...data, latestVersionNo: 1 });
      await createStepVersion(tx, {
        stepApiId: doc.id,
        versionNo: 1,
        contentHash: hash,
        snapshot: { ...data, metadata: raw } as Prisma.InputJsonValue,
        sourceUpdatedAt,
        runId,
      });
      versionsAdded += 1;
    } else if (latest && latest.contentHash === hash) {
      await updateStep(tx, doc.id, data);
    } else {
      const versionNo = (latest?.versionNo ?? 0) + 1;
      try {
        await createStepVersion(tx, {
          stepApiId: doc.id,
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
        const current = await latestStepVersion(tx, doc.id);
        if (!current || current.contentHash !== hash) throw error;
        await updateStep(tx, doc.id, data);
        continue;
      }
      await updateStep(tx, doc.id, { ...data, latestVersionNo: versionNo });
      versionsAdded += 1;
    }
    // Document references persist eagerly with the step; PDF bytes are never
    // fetched here — that queue arrives in a later slice.
    await upsertDocumentReference(tx, {
      stepApiId: doc.id,
      proceedingApiId: doc.vorgang_id,
      referenceId: doc.fundstelle.id,
      documentNumber: doc.fundstelle.dokumentnummer,
      pdfUrl: doc.fundstelle.pdf_url ?? null,
      documentDate: new Date(doc.fundstelle.datum),
      metadata: fundstelleRest as Prisma.InputJsonValue,
    });
    await upsertDipCandidate(tx, runId, index, candidateMeta, []);
    await upsertParliamentaryDiscovery(tx, runId, "vorgangsposition", doc.id);
  }
  return { versionsAdded, capped, backfilled };
}

export async function collectSteps(
  prisma: PrismaClient,
  options: CollectStepsOptions,
): Promise<CollectStepsResult> {
  const runId = runIdSchema.parse(options.runId);
  const hash = scopeInputHash(STEPS_ENDPOINT, options);
  const scope: Record<string, unknown> = {
    electoralTerm: options.electoralTerm,
  };
  if (options.updatedFrom)
    scope.aktualisiertStart = options.updatedFrom.toISOString();
  if (options.updatedTo)
    scope.aktualisiertEnd = options.updatedTo.toISOString();
  if (options.proceedingCap !== undefined)
    scope.proceedingCap = options.proceedingCap;
  if (options.followStoredParents !== undefined)
    scope.followStoredParents = options.followStoredParents;

  const replayed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8135421)`;
    const previous = await findRun(tx, runId);
    if (previous) {
      if (previous.inputHash !== hash || previous.feedId !== STEPS_ENDPOINT)
        throw new Error(
          "Run ID already belongs to a different input; use a new run ID",
        );
      if (previous.status === "completed" && previous.completedAt !== null)
        return previous;
    } else {
      await createRun(tx, {
        id: runId,
        feedId: STEPS_ENDPOINT,
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
      backfilled: 0,
      replayed: true,
    };

  let cursor: string | undefined;
  let valid = 0;
  let invalid = 0;
  let stored = 0;
  let versionsAdded = 0;
  let capped = 0;
  let backfilled = 0;
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
      const kept: StoredStep[] = [];
      const invalidDocs: { index: number; error: string; id: string | null }[] =
        [];
      for (const input of page.documents) {
        const converted = toStoredStep(input, itemIndex);
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
          kept.push(converted);
        }
      }
      const counts = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(8135421)`;
        for (const { index, error, id } of invalidDocs) {
          await upsertDipCandidate(
            tx,
            runId,
            index,
            { endpoint: STEPS_ENDPOINT, id },
            [error],
          );
        }
        return storeStepsPage(tx, runId, kept, {
          followStored: options.followStoredParents ?? false,
          cap: options.proceedingCap,
          fetchVorgang: options.fetchVorgang,
        });
      });
      versionsAdded += counts.versionsAdded;
      capped += counts.capped;
      backfilled += counts.backfilled;
      stored += kept.length - counts.capped;
      for (const { doc } of kept) {
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
      STEPS_ENDPOINT,
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
    backfilled,
    replayed: false,
  };
}

// Live page fetcher for operational use (tests inject fakes). Single-item
// parent/step retrieval reuses the same auth and filter conventions.
export function liveStepsFetcher(apiKey: string): {
  fetchPage: CollectStepsOptions["fetchPage"];
  fetchVorgang: NonNullable<CollectStepsOptions["fetchVorgang"]>;
} {
  const headers = { Authorization: `ApiKey ${apiKey}` };
  return {
    fetchPage: async ({
      wahlperiode,
      aktualisiertStart,
      aktualisiertEnd,
      cursor,
    }) => {
      const query = new URLSearchParams({ format: "json" });
      query.set("f.wahlperiode", String(wahlperiode));
      if (aktualisiertStart)
        query.set("f.aktualisiert.start", aktualisiertStart);
      if (aktualisiertEnd) query.set("f.aktualisiert.end", aktualisiertEnd);
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(
        `https://search.dip.bundestag.de/api/v1/vorgangsposition?${query}`,
        { headers },
      );
      if (!response.ok)
        throw new Error(`DIP /vorgangsposition responded ${response.status}`);
      const body = (await response.json()) as {
        documents?: unknown[];
        cursor?: string;
        numFound?: number;
      };
      if (!Array.isArray(body.documents) || typeof body.cursor !== "string")
        throw new Error("DIP /vorgangsposition returned an unexpected payload");
      return {
        documents: body.documents,
        cursor: body.cursor,
        numFound: body.numFound ?? 0,
      };
    },
    fetchVorgang: async (id: string) => {
      const response = await fetch(
        `https://search.dip.bundestag.de/api/v1/vorgang/${id}?format=json`,
        { headers },
      );
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(`DIP /vorgang/${id} responded ${response.status}`);
      return (await response.json()) as unknown;
    },
  };
}
