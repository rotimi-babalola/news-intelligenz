import type { PrismaClient } from "../generated/prisma/client";

export function listPublications(prisma: PrismaClient) {
  return prisma.publication.findMany({
    orderBy: [{ lastDiscoveredAt: "desc" }, { id: "asc" }],
    take: 100,
    include: { _count: { select: { discoveries: true, versions: true } } },
  });
}

export function getPublicationDetail(prisma: PrismaClient, id: string) {
  return prisma.publication.findUnique({
    where: { id },
    include: {
      versions: { orderBy: [{ versionNo: "asc" }] },
      discoveries: {
        orderBy: [{ discoveredAt: "desc" }],
        take: 20,
        include: { run: { select: { id: true, feedId: true } } },
      },
    },
  });
}
