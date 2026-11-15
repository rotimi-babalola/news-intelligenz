import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "./generated/prisma/client";
import { qualifiedTable } from "./db";

export type SourceKind = "news_feed" | "search_query" | "dip_endpoint";
export type SourceRef = {
  kind: SourceKind;
  key: string;
  scope?: unknown;
};

export function feedSource(feedId: string): SourceRef {
  return { kind: "news_feed", key: feedId };
}

export function searchSource(
  query: string,
  domains?: string[],
  provider?: string,
): SourceRef {
  const scope: Record<string, unknown> = {};
  if (domains) scope.domains = domains;
  if (provider) scope.provider = provider;
  return {
    kind: "search_query",
    key: query,
    scope: Object.keys(scope).length ? scope : undefined,
  };
}

export function dipSource(endpoint: string, electoralTerm?: string): SourceRef {
  return {
    kind: "dip_endpoint",
    key: endpoint,
    scope: electoralTerm ? { electoralTerm } : undefined,
  };
}

export const MAX_ATTEMPTS_DEFAULT = 5;
export const LEASE_MS_DEFAULT = 5 * 60 * 1000;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

export function backoffMs(attempts: number): number {
  return Math.min(
    BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
    BACKOFF_CAP_MS,
  );
}

export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  return null;
}

export class RateLimitedError extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs = 60_000) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

export function dedupeKey(
  runId: string,
  itemIndex: number | null,
  operation: string,
) {
  return `${runId}:${itemIndex ?? "-"}:${operation}`;
}

export type EnqueueSpec = {
  source: SourceRef;
  runId: string;
  itemIndex?: number | null;
  dedupeKey?: string;
  operation: string;
  payload: Prisma.InputJsonValue;
  maxAttempts?: number;
  priority?: number;
};

export async function enqueueJob(
  tx: Prisma.TransactionClient,
  spec: EnqueueSpec,
) {
  const key =
    spec.dedupeKey ??
    dedupeKey(spec.runId, spec.itemIndex ?? null, spec.operation);
  return tx.processingJob.upsert({
    where: { dedupeKey: key },
    create: {
      id: randomUUID(),
      dedupeKey: key,
      sourceKind: spec.source.kind,
      sourceKey: spec.source.key,
      sourceScope: (spec.source.scope ?? undefined) as
        Prisma.InputJsonValue | undefined,
      runId: spec.runId,
      itemIndex: spec.itemIndex ?? null,
      operation: spec.operation,
      payload: spec.payload,
      maxAttempts: spec.maxAttempts ?? MAX_ATTEMPTS_DEFAULT,
      priority: spec.priority ?? 0,
    },
    update: {},
  });
}

export type ClaimedJob = {
  id: string;
  dedupeKey: string;
  sourceKind: SourceKind;
  sourceKey: string;
  sourceScope: unknown;
  runId: string;
  itemIndex: number | null;
  operation: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  priority: number;
};

async function exhaustExpiredClaims(tx: Prisma.TransactionClient) {
  const jobs = qualifiedTable("processing_jobs");
  const attempts = qualifiedTable("job_attempts");
  await tx.$executeRawUnsafe(`WITH expired AS (
    UPDATE ${jobs} SET status = 'exhausted',
      last_error = 'Lease expired after maximum attempts', updated_at = now()
    WHERE status = 'claimed' AND lease_expires_at <= now()
      AND attempts >= max_attempts
    RETURNING id, attempts
  ) UPDATE ${attempts} AS log SET finished_at = now(),
    outcome = 'exhausted', error = 'Lease expired after maximum attempts'
    FROM expired WHERE log.job_id = expired.id
      AND log.attempt_no = expired.attempts AND log.finished_at IS NULL`);
}

export type ClaimFilter = {
  runId?: string;
  jobId?: string;
  excludeSourceKind?: SourceKind;
  operation?: string | string[];
  payloadModel?: string;
  includeModelLess?: boolean;
};

// One atomic claim: exactly one worker wins each ready job. Stale leases
// (worker died mid-processing) are reclaimable by any worker, which is how
// restarts recover without a separate recovery pass.
export async function claimNextJob(
  prisma: PrismaClient,
  workerId: string,
  leaseMs: number = LEASE_MS_DEFAULT,
  filter: ClaimFilter = {},
): Promise<ClaimedJob | null> {
  const params: unknown[] = [workerId, leaseMs / 1000];
  let filterClause = "";
  if (filter.runId) {
    params.push(filter.runId);
    filterClause += ` AND run_id = $${params.length}`;
  }
  if (filter.jobId) {
    params.push(filter.jobId);
    filterClause += ` AND id = $${params.length}`;
  }
  if (filter.excludeSourceKind) {
    params.push(filter.excludeSourceKind);
    filterClause += ` AND source_kind <> $${params.length}`;
  }
  if (filter.operation) {
    params.push(filter.operation);
    filterClause += Array.isArray(filter.operation)
      ? ` AND operation = ANY($${params.length}::text[])`
      : ` AND operation = $${params.length}`;
  }
  if (filter.payloadModel) {
    params.push(filter.payloadModel);
    filterClause +=
      filter.includeModelLess === false
        ? ` AND payload->>'model' = $${params.length}`
        : ` AND (payload->>'model' IS NULL OR payload->>'model' = $${params.length})`;
  }
  const jobsTable = qualifiedTable("processing_jobs");
  return prisma.$transaction(async (tx) => {
    await exhaustExpiredClaims(tx);
    const rows = (await tx.$queryRawUnsafe(
      `UPDATE ${jobsTable} SET
      status = 'claimed',
      claimed_at = now(),
      claimed_by = $1,
      lease_expires_at = now() + make_interval(secs => $2),
      attempts = attempts + 1,
      updated_at = now()
    WHERE id = (
      SELECT id FROM ${jobsTable}
      WHERE next_attempt_at <= now() AND attempts < max_attempts ${filterClause} AND (
        status IN ('pending', 'retrying') OR
        (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
      )
      -- On-demand document requests set a higher priority; ties keep the
      -- earliest ready job first.
      -- shortcut: no (priority, next_attempt_at) index; add one if the jobs
      -- table grows far beyond local single-operator scale.
      ORDER BY priority DESC, next_attempt_at ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, dedupe_key AS "dedupeKey", source_kind AS "sourceKind", source_key AS "sourceKey",
      source_scope AS "sourceScope", run_id AS "runId",
      item_index AS "itemIndex", operation, payload, attempts, max_attempts AS "maxAttempts",
      priority`,
      ...params,
    )) as ClaimedJob[];
    const job = rows[0] ?? null;
    if (!job) return null;
    if (job.attempts > 1)
      await tx.jobAttempt.updateMany({
        where: { jobId: job.id, attemptNo: job.attempts - 1, finishedAt: null },
        data: { finishedAt: new Date(), outcome: "abandoned" },
      });
    await tx.jobAttempt.create({
      data: { jobId: job.id, attemptNo: job.attempts, workerId },
    });
    return job;
  });
}

export async function completeJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  workerId: string,
) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.processingJob.updateMany({
      where: {
        id: job.id,
        status: "claimed",
        attempts: job.attempts,
        claimedBy: workerId,
      },
      data: { status: "succeeded", lastError: null },
    });
    if (!updated.count) return false;
    await tx.jobAttempt.update({
      where: { jobId_attemptNo: { jobId: job.id, attemptNo: job.attempts } },
      data: { finishedAt: new Date(), outcome: "succeeded", workerId },
    });
    return true;
  });
}

export type FailOptions = {
  retryAfterMs?: number;
};

export async function failJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  workerId: string,
  error: Error,
  options: FailOptions = {},
) {
  const retryAfterMs =
    options.retryAfterMs ??
    (error instanceof RateLimitedError ? error.retryAfterMs : undefined);
  const exhausted = job.attempts >= job.maxAttempts;
  const nextAttemptAt = exhausted
    ? null
    : new Date(Date.now() + (retryAfterMs ?? backoffMs(job.attempts)));
  const settled = await prisma.$transaction(async (tx) => {
    const updated = await tx.processingJob.updateMany({
      where: {
        id: job.id,
        status: "claimed",
        attempts: job.attempts,
        claimedBy: workerId,
      },
      data: {
        status: exhausted ? "exhausted" : "retrying",
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
        lastError: error.message.slice(0, 2000),
      },
    });
    if (!updated.count) return false;
    await tx.jobAttempt.update({
      where: { jobId_attemptNo: { jobId: job.id, attemptNo: job.attempts } },
      data: {
        finishedAt: new Date(),
        outcome: exhausted ? "exhausted" : "retrying",
        error: error.message.slice(0, 2000),
        workerId,
      },
    });
    return true;
  });
  return {
    stale: !settled,
    exhausted: settled && exhausted,
    nextAttemptAt: settled ? nextAttemptAt : null,
  };
}

// Restart recovery: stale claims become immediately reclaimable instead of
// waiting for the next claim scan to pick up the expired lease. Epoch makes
// "now" independent of clock agreement between the app and PostgreSQL, so a
// restart always reclaims its own work first. Every runner pass calls this,
// so recovery does not depend on which entry point invoked the worker.
export async function requeueStaleClaims(prisma: PrismaClient) {
  return prisma.$transaction(async (tx) => {
    await exhaustExpiredClaims(tx);
    const count =
      await tx.$executeRawUnsafe(`UPDATE ${qualifiedTable("processing_jobs")}
      SET status = 'retrying', next_attempt_at = to_timestamp(0), updated_at = now()
      WHERE status = 'claimed' AND lease_expires_at <= now()
        AND attempts < max_attempts`);
    return { count };
  });
}

// One settled job's whole life in one value. A handler returns to succeed and
// throws to fail with the job's retry and backoff semantics; it never settles
// the job itself. Data a handler returns rides on the success outcome.
export type JobOutcome<T extends object = Record<never, never>> =
  | ({ status: "succeeded"; jobId: string } & Omit<T, "status" | "jobId">)
  | { status: "retrying" | "exhausted" | "stale"; jobId: string };

export type RunOptions = {
  limit?: number;
  failureMessage?: string;
  onExhausted?: (job: ClaimedJob, error: Error) => Promise<void> | void;
};

async function settleClaimedJob<T extends object>(
  prisma: PrismaClient,
  job: ClaimedJob,
  workerId: string,
  handler: (job: ClaimedJob) => Promise<T | void>,
  options: RunOptions,
): Promise<JobOutcome<T>> {
  try {
    const result = await handler(job);
    if (!(await completeJob(prisma, job, workerId)))
      return { status: "stale", jobId: job.id };
    return { status: "succeeded", jobId: job.id, ...(result ?? ({} as T)) };
  } catch (error) {
    const failure =
      error instanceof Error
        ? error
        : new Error(options.failureMessage ?? "Job processing failed");
    const { exhausted, stale } = await failJob(prisma, job, workerId, failure);
    if (exhausted) await options.onExhausted?.(job, failure);
    return {
      status: stale ? "stale" : exhausted ? "exhausted" : "retrying",
      jobId: job.id,
    };
  }
}

// One worker pass: reclaim expired leases, then claim and settle ready jobs
// until none remain claimable or the limit is reached. Claim, settlement and
// the outcome union live here, so every worker only supplies a filter and a
// handler.
export async function runJobs<T extends object = Record<never, never>>(
  prisma: PrismaClient,
  workerId: string,
  filter: ClaimFilter,
  handler: (job: ClaimedJob) => Promise<T | void>,
  options: RunOptions = {},
): Promise<JobOutcome<T>[]> {
  await requeueStaleClaims(prisma);
  const outcomes: JobOutcome<T>[] = [];
  while (options.limit === undefined || outcomes.length < options.limit) {
    const job = await claimNextJob(prisma, workerId, undefined, filter);
    if (!job) break;
    outcomes.push(
      await settleClaimedJob(prisma, job, workerId, handler, options),
    );
  }
  return outcomes;
}

export async function runNextJob<T extends object = Record<never, never>>(
  prisma: PrismaClient,
  workerId: string,
  filter: ClaimFilter,
  handler: (job: ClaimedJob) => Promise<T | void>,
  options: RunOptions = {},
): Promise<JobOutcome<T> | { status: "empty" }> {
  const [outcome] = await runJobs(prisma, workerId, filter, handler, {
    ...options,
    limit: 1,
  });
  return outcome ?? { status: "empty" };
}

export async function retryExhausted(
  prisma: PrismaClient | Prisma.TransactionClient,
  jobId: string,
) {
  const job = await prisma.processingJob.findUniqueOrThrow({
    where: { id: jobId, status: "exhausted" },
  });
  return prisma.processingJob.update({
    where: { id: jobId, status: "exhausted" },
    data: {
      status: "pending",
      maxAttempts: { increment: job.maxAttempts },
      nextAttemptAt: new Date(),
      lastError: null,
      claimedAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
    },
  });
}

export type JobFilter = "pending" | "retrying" | "exhausted" | "all";

export async function listJobs(
  prisma: PrismaClient,
  filter: JobFilter = "all",
  sourceKinds?: SourceKind[],
) {
  const kindFilter =
    sourceKinds === undefined ? {} : { sourceKind: { in: sourceKinds } };
  return prisma.processingJob.findMany({
    where:
      filter === "all"
        ? kindFilter
        : filter === "pending"
          ? { status: { in: ["pending", "claimed"] }, ...kindFilter }
          : { status: filter, ...kindFilter },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: 100,
  });
}

export async function countOpenJobs(prisma: PrismaClient, runId: string) {
  return prisma.processingJob.count({
    where: { runId, status: { in: ["pending", "claimed", "retrying"] } },
  });
}

export async function jobCounts(
  prisma: PrismaClient,
  sourceKinds?: SourceKind[],
) {
  const groups = await prisma.processingJob.groupBy({
    by: ["status"],
    where: sourceKinds === undefined ? {} : { sourceKind: { in: sourceKinds } },
    _count: true,
  });
  const byStatus: Record<string, number> = {};
  for (const group of groups) {
    byStatus[group.status] = group._count;
  }
  const pending = (byStatus["pending"] ?? 0) + (byStatus["claimed"] ?? 0);
  return {
    pending,
    retrying: byStatus["retrying"] ?? 0,
    exhausted: byStatus["exhausted"] ?? 0,
  };
}
