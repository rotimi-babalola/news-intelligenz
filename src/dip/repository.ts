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

export function findStepVersion(
  client: Client,
  stepApiId: string,
  versionNo: number,
) {
  return client.proceedingStepVersion.findUnique({
    where: { stepApiId_versionNo: { stepApiId, versionNo } },
  });
}

export function saveDipEmbedding(
  client: Client,
  input: {
    sourceEntity: ParliamentaryEntity;
    apiId: string;
    versionNo: number;
    sourcePage?: number;
    sourceChunk?: number;
    model: string;
    documentInstruction: string;
    queryInstruction: string;
    embedding: number[];
  },
) {
  return client.$executeRawUnsafe(
    `INSERT INTO ${qualifiedTable("dip_embeddings")}
      (id, source_entity, source_api_id, source_version_no, source_page, source_chunk, model, document_instruction, query_instruction, embedding)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9::public.vector)
     ON CONFLICT (source_entity, source_api_id, source_version_no, source_page, source_chunk, model, document_instruction) DO NOTHING`,
    input.sourceEntity,
    input.apiId,
    input.versionNo,
    input.sourcePage ?? 0,
    input.sourceChunk ?? 0,
    input.model,
    input.documentInstruction,
    input.queryInstruction,
    JSON.stringify(input.embedding),
  );
}

export type DipSearchRow = {
  entity: ParliamentaryEntity;
  apiId: string;
  versionNo: number;
  score: number;
  title: string;
  summary: string | null;
  stepLabel: string | null;
  proceedingApiId: string | null;
  referenceId: string | null;
  documentNumber: string | null;
  pdfUrl: string | null;
  stepId: string | null;
  pageNo: number | null;
  chunkNo: number | null;
  passage: string | null;
};

// Records join their current version; document text joins the citation and
// only the latest fetched content variant, so historical bytes never produce
// duplicate hits. One citation is chosen per document to keep results unique.
export function searchDipEmbeddings(
  client: Client,
  input: {
    embedding: number[];
    model: string;
    documentInstruction: string;
    queryInstruction: string;
    limit: number;
  },
) {
  return client.$queryRawUnsafe<DipSearchRow[]>(
    `SELECT e.source_entity::text AS "entity", e.source_api_id AS "apiId",
      e.source_version_no AS "versionNo",
      1 - (e.embedding <=> $1::public.vector) AS "score",
      CASE WHEN e.source_entity = 'dokument' THEN dr.document_number
        ELSE COALESCE(p.title, s.title) END AS "title",
      COALESCE(p.metadata->>'abstract', s.metadata->>'abstract') AS "summary",
      s.step_label AS "stepLabel",
      COALESCE(s.proceeding_id, dr.proceeding_id) AS "proceedingApiId",
      dr.reference_id AS "referenceId",
      dr.document_number AS "documentNumber",
      dr.pdf_url AS "pdfUrl",
      dr.step_id AS "stepId",
      CASE WHEN e.source_entity = 'dokument' THEN e.source_page END AS "pageNo",
      CASE WHEN e.source_entity = 'dokument' THEN e.source_chunk END AS "chunkNo",
      dc.text AS "passage"
     FROM ${qualifiedTable("dip_embeddings")} e
     LEFT JOIN ${qualifiedTable("proceedings")} p
       ON e.source_entity = 'vorgang' AND p.api_id = e.source_api_id
       AND p.latest_version_no = e.source_version_no
     LEFT JOIN ${qualifiedTable("proceeding_steps")} s
       ON e.source_entity = 'vorgangsposition' AND s.api_id = e.source_api_id
       AND s.latest_version_no = e.source_version_no
     LEFT JOIN LATERAL (
       SELECT r.reference_id, r.document_number, r.pdf_url, r.step_id,
         r.proceeding_id, c.id AS content_id
       FROM ${qualifiedTable("document_references")} r
       JOIN ${qualifiedTable("document_contents")} c
         ON c.reference_id = r.reference_id
         AND c.variant_no = e.source_version_no AND c.is_latest
       WHERE e.source_entity = 'dokument' AND r.reference_id = e.source_api_id
       ORDER BY r.observed_at DESC
       LIMIT 1
     ) dr ON true
     LEFT JOIN ${qualifiedTable("document_chunks")} dc
       ON e.source_entity = 'dokument' AND dc.content_id = dr.content_id
       AND dc.page_no = e.source_page AND dc.chunk_no = e.source_chunk
     WHERE e.model = $2 AND e.document_instruction = $3 AND e.query_instruction = $4
       AND (p.api_id IS NOT NULL OR s.api_id IS NOT NULL OR dc.content_id IS NOT NULL)
     ORDER BY e.embedding <=> $1::public.vector, e.source_entity, e.source_api_id
     LIMIT $5`,
    JSON.stringify(input.embedding),
    input.model,
    input.documentInstruction,
    input.queryInstruction,
    input.limit,
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

// Capped step collection follows the stored proceeding set; a stable order
// keeps the request sequence reproducible across runs.
export function listProceedingApiIdsByTerm(
  client: Client,
  electoralTerm: number,
) {
  return client.proceeding.findMany({
    where: { electoralTerm },
    select: { apiId: true },
    orderBy: { apiId: "asc" },
  });
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

// Steps are discovered by collection runs; the latest encounter supplies the
// run a later on-demand document job belongs to.
export function latestStepDiscovery(client: Client, apiId: string) {
  return client.parliamentaryDiscovery.findFirst({
    where: { entity: "vorgangsposition", apiId },
    orderBy: { discoveredAt: "desc" },
  });
}

// A reference id may be cited by more than one step; on-demand requests only
// need one stored citation to resolve metadata for the document.
export function findDocumentReferenceById(client: Client, referenceId: string) {
  return client.documentReference.findFirst({
    where: { referenceId },
    orderBy: { observedAt: "desc" },
  });
}

export function findDocumentContentByHash(
  client: Client,
  referenceId: string,
  byteHash: string,
) {
  return client.documentContent.findUnique({
    where: { referenceId_byteHash: { referenceId, byteHash } },
  });
}

export function latestDocumentContent(client: Client, referenceId: string) {
  return client.documentContent.findFirst({
    where: { referenceId, isLatest: true },
    orderBy: { variantNo: "desc" },
  });
}

// Variant numbers only grow, even when an older variant is promoted back to
// latest: reused bytes must never reuse a number held by another variant.
export async function maxDocumentVariantNo(
  client: Client,
  referenceId: string,
) {
  const result = await client.documentContent.aggregate({
    where: { referenceId },
    _max: { variantNo: true },
  });
  return result._max.variantNo ?? 0;
}

export function findDocumentContent(
  client: Client,
  referenceId: string,
  variantNo: number,
) {
  return client.documentContent.findUnique({
    where: { referenceId_variantNo: { referenceId, variantNo } },
  });
}

export function createDocumentContent(
  client: Client,
  data: Prisma.DocumentContentUncheckedCreateInput,
) {
  return client.documentContent.create({ data });
}

export function createDocumentPages(
  client: Client,
  data: Prisma.DocumentPageUncheckedCreateInput[],
) {
  return client.documentPage.createMany({ data });
}

export function listDocumentPages(client: Client, contentId: string) {
  return client.documentPage.findMany({
    where: { contentId },
    orderBy: { pageNo: "asc" },
  });
}

export function findDocumentPage(
  client: Client,
  contentId: string,
  pageNo: number,
) {
  return client.documentPage.findUnique({
    where: { contentId_pageNo: { contentId, pageNo } },
  });
}

export function supersedeDocumentContents(client: Client, referenceId: string) {
  return client.documentContent.updateMany({
    where: { referenceId, isLatest: true },
    data: { isLatest: false },
  });
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
      observedAt: new Date(),
    },
  });
}
