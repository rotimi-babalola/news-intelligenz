import type { PrismaClient } from "../generated/prisma/client";
import type { ClaimedJob } from "./claim";
import { RateLimitedError, backoffMs, isExhausting } from "./policy";

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
  const exhausted = isExhausting(job, error);
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
