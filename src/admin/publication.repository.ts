import type { PrismaClient } from "../generated/prisma/client";

export function listPublications(prisma: PrismaClient) {
  return prisma.publication.findMany({
    orderBy: [{ lastDiscoveredAt: "desc" }, { id: "asc" }],
    take: 100,
    include: { _count: { select: { discoveries: true } } },
  });
}
