import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { createRun, finalizeRun, findRun } from "../import/run.repository";
import { runIdSchema } from "../validation";
import { upsertDipCheckpoint } from "./repository";
import type { FetchVorgangPage } from "./types";
import { scopeInputHash } from "./util";

type Options = {
  runId: string;
  electoralTerm: number;
  updatedFrom?: Date;
  updatedTo?: Date;
  proceedingCap?: number;
  followStoredParents?: boolean;
  fetchPage: FetchVorgangPage;
};

type PageCounts = {
  valid: number;
  invalid: number;
  stored: number;
  versionsAdded: number;
  capped: number;
  backfilled: number;
  maxObserved: Date | null;
};

export async function collectDipPages(
  prisma: PrismaClient,
  endpoint: string,
  options: Options,
  storePage: (
    documents: unknown[],
    firstIndex: number,
    runId: string,
  ) => Promise<PageCounts>,
) {
  const runId = runIdSchema.parse(options.runId);
  const hash = scopeInputHash(endpoint, options);
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
      if (previous.inputHash !== hash || previous.feedId !== endpoint)
        throw new Error(
          "Run ID already belongs to a different input; use a new run ID",
        );
      if (previous.status === "completed" && previous.completedAt !== null)
        return previous;
    } else {
      await createRun(tx, {
        id: runId,
        feedId: endpoint,
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
      status: "completed" as const,
      valid: replayed.validCount,
      invalid: replayed.invalidCount,
      stored: 0,
      versionsAdded: 0,
      capped: 0,
      backfilled: 0,
      replayed: true,
    };

  let cursor: string | undefined;
  let itemIndex = 0;
  let maxObserved: Date | null = null;
  const totals = {
    valid: 0,
    invalid: 0,
    stored: 0,
    versionsAdded: 0,
    capped: 0,
    backfilled: 0,
  };
  try {
    for (;;) {
      const page = await options.fetchPage({
        wahlperiode: options.electoralTerm,
        aktualisiertStart: options.updatedFrom?.toISOString(),
        aktualisiertEnd: options.updatedTo?.toISOString(),
        cursor,
      });
      const counts = await storePage(page.documents, itemIndex, runId);
      itemIndex += page.documents.length;
      totals.valid += counts.valid;
      totals.invalid += counts.invalid;
      totals.stored += counts.stored;
      totals.versionsAdded += counts.versionsAdded;
      totals.capped += counts.capped;
      totals.backfilled += counts.backfilled;
      if (
        counts.maxObserved &&
        (!maxObserved || counts.maxObserved > maxObserved)
      )
        maxObserved = counts.maxObserved;
      if (!page.cursor || page.cursor === cursor) break;
      cursor = page.cursor;
    }
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      await finalizeRun(tx, runId, {
        status: "failed",
        validCount: totals.valid,
        invalidCount: totals.invalid,
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
      validCount: totals.valid,
      invalidCount: totals.invalid,
      completedAt: new Date(),
      error: null,
    });
    await upsertDipCheckpoint(
      tx,
      endpoint,
      options.electoralTerm,
      options.updatedTo ?? maxObserved,
    );
  });
  return { runId, status: "completed" as const, ...totals, replayed: false };
}
