import type { Prisma, PrismaClient } from "../generated/prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

export function createCandidate(
  client: Client,
  data: Prisma.CandidateUncheckedCreateInput,
) {
  return client.candidate.create({ data });
}

export function getCandidate(client: Client, runId: string, itemIndex: number) {
  return client.candidate.findUnique({
    where: { runId_itemIndex: { runId, itemIndex } },
  });
}

export function updateCandidateResult(
  client: Client,
  runId: string,
  itemIndex: number,
  result: { errors: string[]; publicationId: string | null },
) {
  return client.candidate.update({
    where: { runId_itemIndex: { runId, itemIndex } },
    data: result,
  });
}

export function listCandidatesForTally(client: Client, runId: string) {
  return client.candidate.findMany({
    where: { runId },
    select: { errors: true, publicationId: true },
  });
}
