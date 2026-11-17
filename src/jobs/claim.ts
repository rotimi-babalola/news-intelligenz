import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { qualifiedTable } from "../db";
import { LEASE_MS_DEFAULT } from "./policy";
import type { SourceKind } from "./refs";

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

export type ClaimFilter = {
  runId?: string;
  jobId?: string;
  excludeSourceKind?: SourceKind;
  operation?: string | string[];
  payloadModel?: string;
  includeModelLess?: boolean;
};

// A claim whose lease expired with the budget spent is exhausted here, so a
// crashed final attempt never exceeds max_attempts.
export async function exhaustExpiredClaims(tx: Prisma.TransactionClient) {
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
  // Ready and reclaimable work are claimed in two ordered tries instead of one
  // OR: an OR makes the planner bitmap both availability states, losing the
  // index order, so every claim sorts the whole ready set. Each state alone
  // stops at its first row. A ready job therefore wins over a reclaimable one,
  // whose dead worker's priority no longer outranks live work. The ready try is
  // why the partial index in 20261117093000_processing_job_claim_index exists.
  // On-demand document requests set a higher priority; ties keep the earliest
  // ready job first.
  const claimSql = (available: string) => `UPDATE ${jobsTable} SET
      status = 'claimed',
      claimed_at = now(),
      claimed_by = $1,
      lease_expires_at = now() + make_interval(secs => $2),
      attempts = attempts + 1,
      updated_at = now()
    WHERE id = (
      SELECT id FROM ${jobsTable}
      WHERE next_attempt_at <= now() AND attempts < max_attempts ${filterClause} AND ${available}
      ORDER BY priority DESC, next_attempt_at ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, dedupe_key AS "dedupeKey", source_kind AS "sourceKind", source_key AS "sourceKey",
      source_scope AS "sourceScope", run_id AS "runId",
      item_index AS "itemIndex", operation, payload, attempts, max_attempts AS "maxAttempts",
      priority`;
  return prisma.$transaction(async (tx) => {
    await exhaustExpiredClaims(tx);
    const claim = async (available: string) =>
      (
        (await tx.$queryRawUnsafe(
          claimSql(available),
          ...params,
        )) as ClaimedJob[]
      )[0] ?? null;
    const job =
      (await claim("status IN ('pending', 'retrying')")) ??
      (await claim(
        "status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now()",
      ));
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
