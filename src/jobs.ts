import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "./generated/prisma/client";

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
    },
    update: {},
  });
}

// Typed Prisma queries route into the configured schema automatically; raw
// SQL must qualify tables itself. Integration tests run each suite in an
// isolated schema via ?schema=, so an unqualified claim would read the wrong
// (public) table and never find ready jobs.
function qualifiedTable(table: string): string {
  let schema = "public";
  try {
    schema =
      new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema") ||
      "public";
  } catch {
    // Fall through to the default schema.
  }
  const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return `${ident(schema)}.${ident(table)}`;
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
};

// One atomic claim: exactly one worker wins each ready job. Stale leases
// (worker died mid-processing) are reclaimable by any worker, which is how
// restarts recover without a separate recovery pass.
export async function claimNextJob(
  prisma: PrismaClient,
  workerId: string,
  leaseMs: number = LEASE_MS_DEFAULT,
  filter: {
    runId?: string;
    jobId?: string;
    excludeSourceKind?: SourceKind;
  } = {},
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
  const jobsTable = qualifiedTable("processing_jobs");
  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE ${jobsTable} SET
      status = 'claimed',
      claimed_at = now(),
      claimed_by = $1,
      lease_expires_at = now() + make_interval(secs => $2),
      attempts = attempts + 1,
      updated_at = now()
    WHERE id = (
      SELECT id FROM ${jobsTable}
      WHERE next_attempt_at <= now() ${filterClause} AND (
        status IN ('pending', 'retrying') OR
        (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
      )
      ORDER BY next_attempt_at ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, dedupe_key AS "dedupeKey", source_kind AS "sourceKind", source_key AS "sourceKey",
      source_scope AS "sourceScope", run_id AS "runId",
      item_index AS "itemIndex", operation, payload, attempts, max_attempts AS "maxAttempts"`,
    ...params,
  )) as ClaimedJob[];
  const job = rows[0] ?? null;
  if (!job) return null;
  await prisma.jobAttempt.create({
    data: { jobId: job.id, attemptNo: job.attempts, workerId },
  });
  return job;
}

export async function completeJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  workerId: string,
) {
  await prisma.$transaction(async (tx) => {
    await tx.processingJob.update({
      where: { id: job.id },
      data: { status: "succeeded", lastError: null },
    });
    await tx.jobAttempt.update({
      where: { jobId_attemptNo: { jobId: job.id, attemptNo: job.attempts } },
      data: { finishedAt: new Date(), outcome: "succeeded", workerId },
    });
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
  await prisma.$transaction(async (tx) => {
    await tx.processingJob.update({
      where: { id: job.id },
      data: {
        status: exhausted ? "exhausted" : "retrying",
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
        lastError: error.message.slice(0, 2000),
      },
    });
    await tx.jobAttempt.update({
      where: { jobId_attemptNo: { jobId: job.id, attemptNo: job.attempts } },
      data: {
        finishedAt: new Date(),
        outcome: exhausted ? "exhausted" : "retrying",
        error: error.message.slice(0, 2000),
        workerId,
      },
    });
  });
  return { exhausted, nextAttemptAt };
}

// Explicit restart recovery: stale claims become immediately reclaimable
// instead of waiting for the next claim scan to pick up the expired lease.
export async function requeueStaleClaims(prisma: PrismaClient) {
  return prisma.processingJob.updateMany({
    where: {
      status: "claimed",
      leaseExpiresAt: { lte: new Date() },
    },
    data: { status: "retrying", nextAttemptAt: new Date() },
  });
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
) {
  return prisma.processingJob.findMany({
    where:
      filter === "all"
        ? {}
        : filter === "pending"
          ? { status: { in: ["pending", "claimed"] } }
          : { status: filter },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: 100,
  });
}

export async function countOpenJobs(prisma: PrismaClient, runId: string) {
  return prisma.processingJob.count({
    where: { runId, status: { in: ["pending", "claimed", "retrying"] } },
  });
}

export async function jobCounts(prisma: PrismaClient) {
  const groups = await prisma.processingJob.groupBy({
    by: ["status"],
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
