import type { PrismaClient } from "../generated/prisma/client";
import { claimNextJob, type ClaimFilter, type ClaimedJob } from "./claim";
import { requeueStaleClaims } from "./recovery";
import { completeJob, failJob } from "./settle";

// One settled job's whole life in one value. A handler returns to succeed and
// throws to fail with the job's retry and backoff semantics; it never settles
// the job itself. Data a handler returns rides on the success outcome.
export type JobOutcome<T extends object = Record<never, never>> =
  | ({ status: "succeeded"; jobId: string } & Omit<T, "status" | "jobId">)
  | { status: "retrying" | "exhausted" | "stale"; jobId: string };

export type RunOptions = {
  limit?: number;
  failureMessage?: string;
  // Ends the pass on the first outcome that satisfies it, so a caller that
  // must not keep claiming after a particular result (a provider outage) can
  // stop without giving up the batched pass for every other result.
  stopWhen?: (outcome: JobOutcome) => boolean;
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
