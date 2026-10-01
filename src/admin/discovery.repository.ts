import type { PrismaClient } from "../generated/prisma/client";

export function listDiscoveriesByRun(prisma: PrismaClient, runId: string) {
  if (!runId) return Promise.resolve([]);
  return prisma.discovery.findMany({
    where: { runId },
    orderBy: { publicationId: "asc" },
    take: 100,
    include: { run: true, publication: true },
  });
}
