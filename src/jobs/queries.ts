import type { PrismaClient } from "../generated/prisma/client";
import type { SourceKind } from "./refs";

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
