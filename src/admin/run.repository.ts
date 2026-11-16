import type { PrismaClient } from "../generated/prisma/client";

export function listNewsRuns(prisma: PrismaClient) {
  return prisma.run.findMany({
    where: { sourceKind: { in: ["news_feed", "search_query"] } },
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    take: 100,
  });
}
