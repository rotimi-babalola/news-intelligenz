import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { createRun, finalizeRun, findRun } from "../import/run.repository";
import { RateLimitedError, backoffMs } from "../jobs";
import { runIdSchema } from "../validation";
import { findDipCheckpoint, upsertDipCheckpoint } from "./repository";
import type { FetchVorgangPage } from "./types";
import { scopeInputHash } from "./util";

// Terminal failures (bad request, unknown cursor semantics aside) never
// retry: only transient network/5xx/429 errors repeat with bounded backoff.
export class TerminalPageError extends Error {}

type Options = {
  runId: string;
  electoralTerm: number;
  updatedFrom?: Date;
  updatedTo?: Date;
  proceedingCap?: number;
  followStoredParents?: boolean;
  retryDelayMs?: (attempt: number, error: unknown) => number;
  fetchPage: FetchVorgangPage;
};

// Checkpoints never regress: overlapping runs and explicit backfill windows
// report older ends without moving successful progress backward. A null
// target carries no information and leaves existing progress untouched.
export function pickCheckpointTarget(
  current: Date | null,
  target: Date | null,
): Date | null {
  if (!target) return current;
  if (!current || target > current) return target;
  return current;
}

const PAGE_FETCH_ATTEMPTS = 3;

function defaultRetryDelayMs(attempt: number, error: unknown) {
  if (error instanceof RateLimitedError) return error.retryAfterMs;
  return backoffMs(attempt);
}

async function fetchPageWithRetry(
  fetchPage: FetchVorgangPage,
  params: Parameters<FetchVorgangPage>[0],
  retryDelayMs: (attempt: number, error: unknown) => number,
) {
  let attempt = 0;
  for (;;) {
    try {
      return await fetchPage(params);
    } catch (error) {
      attempt += 1;
      if (error instanceof TerminalPageError) throw error;
      if (attempt >= PAGE_FETCH_ATTEMPTS) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, retryDelayMs(attempt, error)),
      );
    }
  }
}
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
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const fetchParams = (cursor: string | undefined) => ({
    wahlperiode: options.electoralTerm,
    aktualisiertStart: options.updatedFrom?.toISOString(),
    aktualisiertEnd: options.updatedTo?.toISOString(),
    cursor,
  });
  const resetTotals = () => {
    // Flow counts recount the final pass, but versions created before the
    // failure persist in storage and stay credited to this run.
    totals.valid = 0;
    totals.invalid = 0;
    totals.stored = 0;
    totals.capped = 0;
    totals.backfilled = 0;
  };
  // An expired cursor surfaces as a mid-pagination failure. Writes are
  // idempotent (same run ID reuses candidates, discoveries, and versions),
  // so the window restarts once from the first page instead of resuming a
  // dead cursor. A first-page failure has no cursor to blame and fails fast.
  let restarted = false;
  try {
    for (;;) {
      let page;
      try {
        page = await fetchPageWithRetry(
          options.fetchPage,
          fetchParams(cursor),
          retryDelayMs,
        );
      } catch (error) {
        if (!restarted && cursor !== undefined) {
          restarted = true;
          cursor = undefined;
          itemIndex = 0;
          maxObserved = null;
          resetTotals();
          continue;
        }
        throw error;
      }
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
      pickCheckpointTarget(
        (await findDipCheckpoint(tx, endpoint, options.electoralTerm))
          ?.updatedThrough ?? null,
        options.updatedTo ?? maxObserved,
      ),
    );
  });
  return { runId, status: "completed" as const, ...totals, replayed: false };
}
