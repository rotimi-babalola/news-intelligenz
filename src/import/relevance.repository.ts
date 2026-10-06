import type { Prisma, PrismaClient } from "../generated/prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

export type ReviewDecision = "accepted" | "uncertain" | "rejected";

export function upsertReview(
  client: Client,
  data: {
    runId: string;
    itemIndex: number;
    decision: ReviewDecision;
    reason: string;
    decidedBy: string;
  },
) {
  return client.relevanceReview.upsert({
    where: {
      runId_itemIndex: { runId: data.runId, itemIndex: data.itemIndex },
    },
    create: data,
    update: {
      decision: data.decision,
      reason: data.reason,
      decidedBy: data.decidedBy,
      decidedAt: new Date(),
    },
  });
}

export function getReview(client: Client, runId: string, itemIndex: number) {
  return client.relevanceReview.findUnique({
    where: { runId_itemIndex: { runId, itemIndex } },
  });
}
