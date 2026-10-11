import type {
  ParliamentaryEntity,
  Prisma,
  PrismaClient,
} from "../generated/prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

// All PostgreSQL reads and writes for parliamentary records live here;
// src/dip/vorgang.ts orchestrates collection without touching the client
// directly. Steps (slice 4) reuse the discovery, candidate, and checkpoint
// helpers below.

export function findProceeding(client: Client, apiId: string) {
  return client.proceeding.findUnique({ where: { apiId } });
}

export function latestProceedingVersion(
  client: Client,
  proceedingApiId: string,
) {
  return client.proceedingVersion.findFirst({
    where: { proceedingApiId },
    orderBy: { versionNo: "desc" },
  });
}

export function createProceeding(
  client: Client,
  data: Prisma.ProceedingUncheckedCreateInput,
) {
  return client.proceeding.create({ data });
}

export function updateProceeding(
  client: Client,
  apiId: string,
  data: Prisma.ProceedingUncheckedUpdateInput,
) {
  return client.proceeding.update({ where: { apiId }, data });
}

export function createProceedingVersion(
  client: Client,
  data: Prisma.ProceedingVersionUncheckedCreateInput,
) {
  return client.proceedingVersion.create({ data });
}

export function countProceedingsByTerm(client: Client, electoralTerm: number) {
  return client.proceeding.count({ where: { electoralTerm } });
}

export function upsertDipCandidate(
  client: Client,
  runId: string,
  itemIndex: number,
  metadata: Prisma.InputJsonValue,
  errors: string[],
) {
  return client.candidate.upsert({
    where: { runId_itemIndex: { runId, itemIndex } },
    create: { runId, itemIndex, metadata, errors },
    update: {},
  });
}

export function upsertParliamentaryDiscovery(
  client: Client,
  runId: string,
  entity: ParliamentaryEntity,
  apiId: string,
) {
  return client.parliamentaryDiscovery.upsert({
    where: { runId_entity_apiId: { runId, entity, apiId } },
    create: { runId, entity, apiId },
    update: {},
  });
}

export function upsertDipCheckpoint(
  client: Client,
  endpoint: string,
  electoralTerm: number,
  updatedThrough: Date | null,
) {
  return client.dipCheckpoint.upsert({
    where: { endpoint_electoralTerm: { endpoint, electoralTerm } },
    create: { endpoint, electoralTerm, updatedThrough },
    update: { updatedThrough },
  });
}
