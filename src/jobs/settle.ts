import type { PrismaClient } from "../generated/prisma/client";
import { qualifiedTable } from "../db";
import type { ClaimedJob } from "./claim";
import { RateLimitedError, backoffMs, isExhausting } from "./policy";

// Positional VALUES rows for one statement, one parameter per column.
function valueRows(rowCount: number, columnCount: number) {
  return Array.from({ length: rowCount }, (_unused, row) => {
    const params = Array.from(
      { length: columnCount },
      (_unusedColumn, column) => `$${row * columnCount + column + 1}`,
    );
    return `(${params.join(", ")})`;
  }).join(", ");
}

// Batch settlement keeps one statement and one commit for a whole batch, so a
// batch costs the same round trips whether it holds one passage or 64. Each row
// is matched on its claimed attempt, the same guard the single settle uses.
export async function completeJobs(
  prisma: PrismaClient,
  jobs: ClaimedJob[],
  workerId: string,
) {
  if (!jobs.length) return new Set<string>();
  const values = valueRows(jobs.length, 2);
  const params: unknown[] = jobs.flatMap((job) => [job.id, job.attempts]);
  params.push(workerId);
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `WITH completed AS (
      UPDATE ${qualifiedTable("processing_jobs")} AS job SET
        status = 'succeeded', last_error = NULL, updated_at = now()
      FROM (VALUES ${values}) AS v(id, attempts)
      WHERE job.id = v.id::uuid AND job.status = 'claimed'
        AND job.attempts = v.attempts::int AND job.claimed_by = $${params.length}
      RETURNING job.id, job.attempts
    )
    UPDATE ${qualifiedTable("job_attempts")} AS log SET
      finished_at = now(), outcome = 'succeeded', worker_id = $${params.length}
    FROM completed
    WHERE log.job_id = completed.id AND log.attempt_no = completed.attempts
    RETURNING log.job_id AS id`,
    ...params,
  );
  return new Set(rows.map((row) => row.id));
}

export type BatchFailure = { job: ClaimedJob; error: Error };
export type SettledFailure = BatchFailure & {
  stale: boolean;
  exhausted: boolean;
};

export async function failJobs(
  prisma: PrismaClient,
  failures: BatchFailure[],
  workerId: string,
): Promise<SettledFailure[]> {
  if (!failures.length) return [];
  const planned = failures.map((failure) => ({
    ...failure,
    ...planFailure(failure.job, failure.error),
  }));
  const values = valueRows(planned.length, 5);
  const params: unknown[] = planned.flatMap((failure) => [
    failure.job.id,
    failure.job.attempts,
    failure.exhausted,
    failure.nextAttemptAt,
    failure.lastError,
  ]);
  params.push(workerId);
  const jobStatus = qualifiedTable("JobStatus");
  const settled = await prisma.$queryRawUnsafe<
    { id: string; exhausted: boolean }[]
  >(
    `WITH failed AS (
      UPDATE ${qualifiedTable("processing_jobs")} AS job SET
        status = CASE WHEN v.exhausted::boolean
          THEN 'exhausted'::${jobStatus} ELSE 'retrying'::${jobStatus} END,
        next_attempt_at = COALESCE(v.next_attempt_at::timestamptz, job.next_attempt_at),
        last_error = v.error, updated_at = now()
      FROM (VALUES ${values}) AS v(id, attempts, exhausted, next_attempt_at, error)
      WHERE job.id = v.id::uuid AND job.status = 'claimed'
        AND job.attempts = v.attempts::int AND job.claimed_by = $${params.length}
      RETURNING job.id, job.attempts, v.exhausted::boolean AS exhausted, v.error
    )
    UPDATE ${qualifiedTable("job_attempts")} AS log SET
      finished_at = now(),
      outcome = CASE WHEN failed.exhausted THEN 'exhausted' ELSE 'retrying' END,
      error = failed.error, worker_id = $${params.length}
    FROM failed
    WHERE log.job_id = failed.id AND log.attempt_no = failed.attempts
    RETURNING log.job_id AS id, failed.exhausted`,
    ...params,
  );
  const settledIds = new Set(settled.map((row) => row.id));
  return planned.map((failure) => ({
    job: failure.job,
    error: failure.error,
    stale: !settledIds.has(failure.job.id),
    exhausted: failure.exhausted,
  }));
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

// Both the single and batch paths must compute exhaustion, the provider's
// delay and the stored error the same way.
function planFailure(job: ClaimedJob, error: Error, retryAfterMs?: number) {
  const exhausted = isExhausting(job, error);
  const delay =
    retryAfterMs ??
    (error instanceof RateLimitedError ? error.retryAfterMs : undefined);
  return {
    exhausted,
    nextAttemptAt: exhausted
      ? null
      : new Date(Date.now() + (delay ?? backoffMs(job.attempts))),
    lastError: error.message.slice(0, 2000),
  };
}

export async function failJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  workerId: string,
  error: Error,
  options: FailOptions = {},
) {
  const { exhausted, nextAttemptAt, lastError } = planFailure(
    job,
    error,
    options.retryAfterMs,
  );
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
        lastError,
      },
    });
    if (!updated.count) return false;
    await tx.jobAttempt.update({
      where: { jobId_attemptNo: { jobId: job.id, attemptNo: job.attempts } },
      data: {
        finishedAt: new Date(),
        outcome: exhausted ? "exhausted" : "retrying",
        error: lastError,
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
