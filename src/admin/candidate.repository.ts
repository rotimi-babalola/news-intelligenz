import type { PrismaClient } from "../generated/prisma/client";

export function listCandidatesByRun(prisma: PrismaClient, runId: string) {
  if (!runId) return Promise.resolve([]);
  return prisma.candidate.findMany({
    where: { runId },
    orderBy: { itemIndex: "asc" },
    take: 100,
  });
}
