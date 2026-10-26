import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { createRun, finalizeRun, findRun } from "../import/run.repository";
import { RateLimitedError, backoffMs } from "../jobs";
import { runIdSchema } from "../validation";
import {
  countProceedingsByTerm,
  findDipCheckpoint,
  upsertDipCheckpoint,
} from "./repository";
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
  // Step collection can query only the stored parent set. Batched because the
  // DIP API takes the filter as repeated query params.
  scopeToStoredProceedings?: boolean;
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
// Each record makes several sequential DB calls; keep interactive transactions short.
export const PAGE_WRITE_BATCH_SIZE = 5;

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
  if (options.scopeToStoredProceedings !== undefined)
    scope.scopeToStoredProceedings = options.scopeToStoredProceedings;

  const previousRun = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8135421)`;
    const previous = await findRun(tx, runId);
    if (previous) {
      if (previous.inputHash !== hash || previous.feedId !== endpoint)
        throw new Error(
          "Run ID already belongs to a different input; use a new run ID",
        );
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
  if (previousRun?.status === "completed" && previousRun.completedAt !== null)
    return {
      runId,
      status: "completed" as const,
      valid: previousRun.validCount,
      invalid: previousRun.invalidCount,
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
  if (previousRun) {
    const proceedingVersions = await prisma.proceedingVersion.count({
      where: { runId },
    });
    totals.versionsAdded = proceedingVersions;
    if (endpoint === "/vorgangsposition") {
      totals.versionsAdded += await prisma.proceedingStepVersion.count({
        where: { runId },
      });
      totals.backfilled = proceedingVersions;
    }
  }
  const addTotals = (target: Totals, counts: Totals) => {
    target.valid += counts.valid;
    target.invalid += counts.invalid;
    target.stored += counts.stored;
    target.versionsAdded += counts.versionsAdded;
    target.capped += counts.capped;
    target.backfilled += counts.backfilled;
  };
  // A cursor restart recounts flow, but committed versions stay credited.
  const rollbackFlowTotals = (counts: Totals) => {
    totals.valid -= counts.valid;
    totals.invalid -= counts.invalid;
    totals.stored -= counts.stored;
    totals.capped -= counts.capped;
  };
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  // One filter group means a normal term-wide scan. Stored-proceeding step
  // collection supplies parent IDs, so each group is one `f.vorgang` batch.
  const groups: (string[] | undefined)[] =
    options.vorgangIds === undefined
      ? [undefined]
      : batch(options.vorgangIds, STEP_FILTER_BATCH);
  try {
    // The early-stop shortcut is only safe when the cap was empty at the
    // start: a later page can then only add capped records. When proceedings
    // are already stored, later pages may hold updates to known records.
    const firstBaseline =
      options.proceedingCap !== undefined &&
      options.updatedFrom === undefined &&
      options.vorgangIds === undefined &&
      (await countProceedingsByTerm(prisma, options.electoralTerm)) === 0;
    let stopped = false;
    for (const vorgangIds of groups) {
      if (stopped) break;
      let cursor: string | undefined;
      const groupStartIndex = itemIndex;
      let groupTotals = zeroTotals();
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
            rollbackFlowTotals(groupTotals);
            groupTotals = zeroTotals();
            continue;
          }
          throw error;
        }
        const counts = await storePage(page.documents, itemIndex, runId);
        itemIndex += page.documents.length;
        addTotals(totals, counts);
        addTotals(groupTotals, counts);
        if (
          counts.maxObserved &&
          (!maxObserved || counts.maxObserved > maxObserved)
        )
          maxObserved = counts.maxObserved;
        // An empty-cap baseline keeps only the first N records; once a page
        // starts skipping, every later page can only be capped, so stop instead
        // of paginating the whole term. Incremental windows and runs that
        // already store records still page fully so updates are never missed.
        if (firstBaseline && counts.capped > 0) {
          stopped = true;
          break;
        }
        if (!page.cursor || page.cursor === cursor) break;
        cursor = page.cursor;
      }
    }
  } catch (error) {
    // Earlier page batches may have committed before a later batch failed.
    const candidates = { runId, itemIndex: { gte: 0 } };
    const [count, valid] = await Promise.all([
      prisma.candidate.count({ where: candidates }),
      prisma.candidate.count({
        where: { ...candidates, errors: { equals: [] } },
      }),
    ]);
    await prisma.$transaction(async (tx) => {
      await finalizeRun(tx, runId, {
        status: "failed",
        validCount: valid,
        invalidCount: count - valid,
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
    // A stored-proceeding scan still covers every proceeding this run knows
    // about, so its window advances like any other completed scan.
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
