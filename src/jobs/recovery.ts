import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { qualifiedTable } from "../db";
import { exhaustExpiredClaims } from "./claim";

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

// Deliberate operator retry of an exhausted job: resets the budget by the same
// amount again instead of leaving the job terminal.
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
