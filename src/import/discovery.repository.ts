import type { Prisma, PrismaClient } from "../generated/prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

export function upsertDiscovery(
  client: Client,
  runId: string,
  publicationId: string,
) {
  return client.discovery.upsert({
    where: { runId_publicationId: { runId, publicationId } },
    create: { runId, publicationId },
    update: {},
  });
}
