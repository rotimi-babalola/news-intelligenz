import type { PrismaClient } from "../generated/prisma/client";
import {
  claimNextJob,
  claimNextJobs,
  type ClaimFilter,
  type ClaimedJob,
} from "./claim";
import { requeueStaleClaims } from "./recovery";
import {
  completeJob,
  completeJobs,
  failJob,
  failJobs,
  type BatchFailure,
} from "./settle";

// One settled job's whole life in one value. A handler returns to succeed and
// throws to fail with the job's retry and backoff semantics; it never settles
// the job itself. Data a handler returns rides on the success outcome.
export type JobOutcome<T extends object = Record<never, never>> =
  | ({ status: "succeeded"; jobId: string } & Omit<T, "status" | "jobId">)
  | { status: "retrying" | "exhausted" | "stale"; jobId: string };

// A batch handler settles provider work for the whole batch and reports which
// jobs it covered. A throw fails every job in the batch, which is what an
// outage of the shared provider means. A stale write still settles the row.
export type JobBatch = {
  succeeded: ClaimedJob[];
  failed: BatchFailure[];
};

// One batched pass iteration, claim to settle included, for the caller's
// throughput log.
export type BatchStats = {
  jobs: number;
  succeeded: number;
  failed: number;
  durationMs: number;
};

export type RunOptions = {
  limit?: number;
  failureMessage?: string;
  // Ends the pass on the first outcome that satisfies it, so a caller that
  // must not keep claiming after a particular result (a provider outage) can
  // stop without giving up the batched pass for every other result.
  stopWhen?: (outcome: JobOutcome) => boolean;
  onExhausted?: (job: ClaimedJob, error: Error) => Promise<void> | void;
  // Batched passes only: reports each iteration's work and wall time.
  onBatch?: (stats: BatchStats) => void;
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
    const outcome = await settleClaimedJob(
      prisma,
      job,
      workerId,
      handler,
      options,
    );
    outcomes.push(outcome);
    if (options.stopWhen?.(outcome)) break;
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

async function settleJobBatch(
  prisma: PrismaClient,
  jobs: ClaimedJob[],
  workerId: string,
  handler: (jobs: ClaimedJob[]) => Promise<JobBatch>,
  options: RunOptions,
): Promise<JobOutcome[]> {
  let batch: JobBatch;
  try {
    batch = await handler(jobs);
  } catch (error) {
    const failure =
      error instanceof Error
        ? error
        : new Error(options.failureMessage ?? "Job batch failed");
    batch = {
      succeeded: [],
      failed: jobs.map((job) => ({ job, error: failure })),
    };
  }
  // A handler that forgets a job must not leave it claimed for the whole lease.
  const accounted = new Set([
    ...batch.succeeded.map((job) => job.id),
    ...batch.failed.map(({ job }) => job.id),
  ]);
  batch.failed.push(
    ...jobs
      .filter((job) => !accounted.has(job.id))
      .map((job) => ({
        job,
        error: new Error(
          options.failureMessage ?? "Job batch left work unsettled",
        ),
      })),
  );
  const completed = await completeJobs(prisma, batch.succeeded, workerId);
  const failed = await failJobs(prisma, batch.failed, workerId);
  for (const failure of failed)
    if (failure.exhausted && !failure.stale)
      await options.onExhausted?.(failure.job, failure.error);
  return [
    ...batch.succeeded.map(
      (job) =>
        (completed.has(job.id)
          ? { status: "succeeded", jobId: job.id }
          : { status: "stale", jobId: job.id }) as JobOutcome,
    ),
    ...failed.map(
      (failure) =>
        ({
          status: failure.stale
            ? "stale"
            : failure.exhausted
              ? "exhausted"
              : "retrying",
          jobId: failure.job.id,
        }) as JobOutcome,
    ),
  ];
}

// A batched pass: one recovery, then claim up to a batch at a time, hand the
// whole batch to the handler, and settle it in two statements. The limit is
// jobs, not batches, so a caller's cap keeps meaning work done.
export async function runJobBatches(
  prisma: PrismaClient,
  workerId: string,
  filter: ClaimFilter,
  batchSize: number,
  handler: (jobs: ClaimedJob[]) => Promise<JobBatch>,
  options: RunOptions = {},
): Promise<JobOutcome[]> {
  await requeueStaleClaims(prisma);
  const outcomes: JobOutcome[] = [];
  while (options.limit === undefined || outcomes.length < options.limit) {
    const size =
      options.limit === undefined
        ? batchSize
        : Math.min(batchSize, options.limit - outcomes.length);
    if (size <= 0) break;
    const startedAt = Date.now();
    const jobs = await claimNextJobs(prisma, workerId, undefined, filter, size);
    if (!jobs.length) break;
    const settled = await settleJobBatch(
      prisma,
      jobs,
      workerId,
      handler,
      options,
    );
    const succeeded = settled.filter(
      (outcome) => outcome.status === "succeeded",
    ).length;
    options.onBatch?.({
      jobs: jobs.length,
      succeeded,
      failed: settled.length - succeeded,
      durationMs: Date.now() - startedAt,
    });
    outcomes.push(...settled);
    if (settled.some((outcome) => options.stopWhen?.(outcome))) break;
  }
  return outcomes;
}
