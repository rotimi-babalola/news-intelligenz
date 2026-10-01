import type { PrismaClient } from "../generated/prisma/client";

export async function listDiscoveriesByRun(
  prisma: PrismaClient,
  runId: string,
) {
  if (!runId) return [];
  return prisma.discovery.findMany({
    where: { runId },
    orderBy: { publicationId: "asc" },
    take: 100,
    include: { run: true, publication: true },
  });
}
