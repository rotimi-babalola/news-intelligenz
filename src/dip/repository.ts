import type {
  ParliamentaryEntity,
  Prisma,
  PrismaClient,
} from "../generated/prisma/client";
import { qualifiedTable } from "../db";

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

export function findProceedingVersion(
  client: Client,
  proceedingApiId: string,
  versionNo: number,
) {
  return client.proceedingVersion.findUnique({
    where: { proceedingApiId_versionNo: { proceedingApiId, versionNo } },
  });
}

export function saveProceedingEmbedding(
  client: Client,
  input: {
    apiId: string;
    versionNo: number;
    model: string;
    documentInstruction: string;
    queryInstruction: string;
    embedding: number[];
  },
) {
  return client.$executeRawUnsafe(
    `INSERT INTO ${qualifiedTable("dip_embeddings")}
      (id, source_entity, source_api_id, source_version_no, model, document_instruction, query_instruction, embedding)
     VALUES (gen_random_uuid(), 'vorgang', $1, $2, $3, $4, $5, $6::public.vector)
     ON CONFLICT (source_entity, source_api_id, source_version_no, model, document_instruction, query_instruction) DO NOTHING`,
    input.apiId,
    input.versionNo,
    input.model,
    input.documentInstruction,
    input.queryInstruction,
    JSON.stringify(input.embedding),
  );
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
    update: { metadata, errors },
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

export function findDipCheckpoint(
  client: Client,
  endpoint: string,
  electoralTerm: number,
) {
  return client.dipCheckpoint.findUnique({
    where: { endpoint_electoralTerm: { endpoint, electoralTerm } },
  });
}

// A failed window remains a gap until a successful window for the same scope
// covers it. Run history stays intact after recovery.
export type DipGap = {
  runId: string;
  endpoint: string;
  electoralTerm: number | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  error: string | null;
  startedAt: Date;
};

function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function scopeKey(endpoint: string, scope: Record<string, unknown>) {
  return JSON.stringify([
    endpoint,
    scope["electoralTerm"],
    scope["proceedingCap"] ?? null,
    scope["followStoredParents"] ?? false,
  ]);
}

export async function listDipGaps(
  client: Client,
  limit = 50,
): Promise<DipGap[]> {
  const runs = await client.run.findMany({
    where: { sourceKind: "dip_endpoint", status: "failed" },
    orderBy: { startedAt: "desc" },
  });
  if (runs.length === 0) return [];
  const failures = runs.map((run) => {
    const scope = (run.sourceScope ?? {}) as Record<string, unknown>;
    return {
      runId: run.id,
      endpoint: run.feedId,
      electoralTerm:
        typeof scope["electoralTerm"] === "number"
          ? scope["electoralTerm"]
          : null,
      windowStart: asDate(scope["aktualisiertStart"]),
      windowEnd: asDate(scope["aktualisiertEnd"]),
      error: run.error,
      startedAt: run.startedAt,
      scopeKey: scopeKey(run.feedId, scope),
    };
  });
  // shortcut: inspect DIP run history in memory; add indexed recovery state
  // when the number of completed windows makes this admin query expensive.
  const completed = await client.run.findMany({
    where: {
      sourceKind: "dip_endpoint",
      status: "completed",
      feedId: { in: [...new Set(failures.map((gap) => gap.endpoint))] },
    },
    select: { feedId: true, sourceScope: true },
  });
  const windows = new Map<string, { start: Date | null; end: Date | null }[]>();
  for (const run of completed) {
    const scope = (run.sourceScope ?? {}) as Record<string, unknown>;
    const key = scopeKey(run.feedId, scope);
    const window = {
      start: asDate(scope["aktualisiertStart"]),
      end: asDate(scope["aktualisiertEnd"]),
    };
    const scoped = windows.get(key) ?? [];
    scoped.push(window);
    windows.set(key, scoped);
  }
  return failures
    .filter((gap) => {
      const successes = windows.get(gap.scopeKey) ?? [];
      return !successes.some(
        (success) =>
          gap.windowEnd &&
          success.end &&
          success.end >= gap.windowEnd &&
          (success.start === null ||
            (gap.windowStart !== null && success.start <= gap.windowStart)),
      );
    })
    .slice(0, limit)
    .map(({ scopeKey: _scopeKey, ...gap }) => gap);
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

export function findStep(client: Client, apiId: string) {
  return client.proceedingStep.findUnique({ where: { apiId } });
}

export function latestStepVersion(client: Client, stepApiId: string) {
  return client.proceedingStepVersion.findFirst({
    where: { stepApiId },
    orderBy: { versionNo: "desc" },
  });
}

export function createStep(
  client: Client,
  data: Prisma.ProceedingStepUncheckedCreateInput,
) {
  return client.proceedingStep.create({ data });
}

export function updateStep(
  client: Client,
  apiId: string,
  data: Prisma.ProceedingStepUncheckedUpdateInput,
) {
  return client.proceedingStep.update({ where: { apiId }, data });
}

export function createStepVersion(
  client: Client,
  data: Prisma.ProceedingStepVersionUncheckedCreateInput,
) {
  return client.proceedingStepVersion.create({ data });
}

export function findDocumentReference(client: Client, stepApiId: string) {
  return client.documentReference.findUnique({ where: { stepApiId } });
}

export function upsertDocumentReference(
  client: Client,
  data: Prisma.DocumentReferenceUncheckedCreateInput,
) {
  return client.documentReference.upsert({
    where: { stepApiId: data.stepApiId },
    create: data,
    update: {
      proceedingApiId: data.proceedingApiId,
      referenceId: data.referenceId,
      documentNumber: data.documentNumber,
      pdfUrl: data.pdfUrl,
      documentDate: data.documentDate,
      metadata: data.metadata,
    },
  });
}
