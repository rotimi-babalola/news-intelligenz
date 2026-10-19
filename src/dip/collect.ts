import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { createRun, finalizeRun, findRun } from "../import/run.repository";
import { RateLimitedError, backoffMs } from "../jobs";
import { runIdSchema } from "../validation";
import { findDipCheckpoint, upsertDipCheckpoint } from "./repository";
import type { FetchVorgangPage, PageParams } from "./types";
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
  // Step collection with a proceeding cap queries only the stored parent set.
  // Batched because the DIP API takes the filter as repeated query params.
  // Such a run also leaves the term checkpoint untouched: it observes a subset
  // of the term, so advancing the checkpoint would hide steps of proceedings
  // stored by a later run.
  vorgangIds?: string[];
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

// The DIP API takes `f.vorgang` as a repeatable query parameter, so capped
// step collection asks for the stored parent set in URL-sized batches instead
// of paginating the whole term.
const STEP_FILTER_BATCH = 50;

function batch<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    batches.push(items.slice(i, i + size));
  return batches;
}

function defaultRetryDelayMs(attempt: number, error: unknown) {
  if (error instanceof RateLimitedError) return error.retryAfterMs;
  return backoffMs(attempt);
}

async function fetchPageWithRetry(
  fetchPage: Options["fetchPage"],
  params: PageParams,
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

  let itemIndex = 0;
  let maxObserved: Date | null = null;
  type Totals = {
    valid: number;
    invalid: number;
    stored: number;
    versionsAdded: number;
    capped: number;
    backfilled: number;
  };
  const zeroTotals = (): Totals => ({
    valid: 0,
    invalid: 0,
    stored: 0,
    versionsAdded: 0,
    capped: 0,
    backfilled: 0,
  });
  const totals = zeroTotals();
  const addTotals = (target: Totals, counts: Totals, sign: 1 | -1) => {
    target.valid += sign * counts.valid;
    target.invalid += sign * counts.invalid;
    target.stored += sign * counts.stored;
    target.versionsAdded += sign * counts.versionsAdded;
    target.capped += sign * counts.capped;
    target.backfilled += sign * counts.backfilled;
  };
  // A cursor restart recounts flow, but versions created before the failure
  // persist in storage and stay credited to this run. Rolling back the flow
  // counters alone avoids double counting them.
  const rollbackFlowTotals = (counts: Totals) => {
    totals.valid -= counts.valid;
    totals.invalid -= counts.invalid;
    totals.stored -= counts.stored;
    totals.capped -= counts.capped;
    totals.backfilled -= counts.backfilled;
  };
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  // One filter group means a normal term-wide scan. Capped step collection
  // supplies parent IDs, so each group is one `f.vorgang` batch.
  const groups: (string[] | undefined)[] =
    options.vorgangIds === undefined
      ? [undefined]
      : batch(options.vorgangIds, STEP_FILTER_BATCH);
  try {
    let stopped = false;
    for (const vorgangIds of groups) {
      if (stopped) break;
      let cursor: string | undefined;
      const groupStartIndex = itemIndex;
      const groupTotals = zeroTotals();
      // An expired cursor surfaces as a mid-pagination failure. Writes are
      // idempotent (same run ID reuses candidates, discoveries, and versions),
      // so the group restarts once from its first page instead of resuming a
      // dead cursor. A first-page failure has no cursor to blame and fails
      // fast.
      let restarted = false;
      for (;;) {
        let page;
        try {
          page = await fetchPageWithRetry(
            options.fetchPage,
            {
              wahlperiode: options.electoralTerm,
              aktualisiertStart: options.updatedFrom?.toISOString(),
              aktualisiertEnd: options.updatedTo?.toISOString(),
              cursor,
              ...(vorgangIds === undefined ? {} : { vorgangIds }),
            },
            retryDelayMs,
          );
        } catch (error) {
          if (!restarted && cursor !== undefined) {
            restarted = true;
            cursor = undefined;
            itemIndex = groupStartIndex;
            // Flow counts recount the final pass, but versions created before
            // the failure persist in storage and stay credited to this run.
            rollbackFlowTotals(groupTotals);
            groupTotals.valid = 0;
            groupTotals.invalid = 0;
            groupTotals.stored = 0;
            groupTotals.capped = 0;
            groupTotals.backfilled = 0;
            continue;
          }
          throw error;
        }
        const counts = await storePage(page.documents, itemIndex, runId);
        itemIndex += page.documents.length;
        addTotals(totals, counts, 1);
        addTotals(groupTotals, counts, 1);
        if (
          counts.maxObserved &&
          (!maxObserved || counts.maxObserved > maxObserved)
        )
          maxObserved = counts.maxObserved;
        // A baseline scan with a local cap keeps only the first N records; once
        // a page starts skipping, every later page can only be capped, so stop
        // instead of paginating the whole term. Incremental windows still page
        // fully so updates to stored records are never missed.
        if (
          options.proceedingCap !== undefined &&
          options.updatedFrom === undefined &&
          options.vorgangIds === undefined &&
          counts.capped > 0
        ) {
          stopped = true;
          break;
        }
        if (!page.cursor || page.cursor === cursor) break;
        cursor = page.cursor;
      }
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
    await tx.candidate.deleteMany({
      where: { runId, itemIndex: { gte: itemIndex } },
    });
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
      options.vorgangIds !== undefined
        ? ((await findDipCheckpoint(tx, endpoint, options.electoralTerm))
            ?.updatedThrough ?? null)
        : pickCheckpointTarget(
            (await findDipCheckpoint(tx, endpoint, options.electoralTerm))
              ?.updatedThrough ?? null,
            options.updatedTo ?? maxObserved,
          ),
    );
  });
  return { runId, status: "completed" as const, ...totals, replayed: false };
}
