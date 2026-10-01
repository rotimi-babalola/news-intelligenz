import type { PrismaClient } from "../generated/prisma/client";

export async function listCandidatesByRun(prisma: PrismaClient, runId: string) {
  if (!runId) return [];
  return prisma.candidate.findMany({
    where: { runId },
    orderBy: { itemIndex: "asc" },
    take: 100,
  });
}
