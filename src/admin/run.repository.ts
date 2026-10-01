import type { PrismaClient } from "../generated/prisma/client";

export function listRuns(prisma: PrismaClient) {
  return prisma.run.findMany({
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    take: 100,
  });
}

export function getRunOrThrow(prisma: PrismaClient, id: string) {
  return prisma.run.findUniqueOrThrow({ where: { id } });
}
