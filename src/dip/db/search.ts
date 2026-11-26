import type {
  ParliamentaryEntity,
  Prisma,
  PrismaClient,
} from "../../generated/prisma/client";
import { qualifiedTable } from "../../db";
import {
  DIP_SEARCH_CANDIDATE_LIMIT,
  DIP_SEARCH_DOCUMENTS_PER_PROCEEDING,
  DIP_SEARCH_HNSW_EF_SEARCH,
  DIP_SEARCH_HNSW_MAX_SCAN_TUPLES,
} from "../constants";
import type { Client } from "./client";

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
  requestedUrl: string | null;
  institution: string | null;
  documentType: string | null;
  referenceMetadata: Prisma.JsonValue | null;
  stepId: string | null;
  pageNo: number | null;
  chunkNo: number | null;
  passage: string | null;
  sectionLabel: string | null;
  sectionTitle: string | null;
  sectionStartPage: number | null;
  sectionEndPage: number | null;
};

// Records join their current version; document text joins the citation and
// only the latest fetched content variant, so historical bytes never produce
// duplicate hits. Eligibility (current version, current variant, stored chunk,
// existing reference step) is applied inside the candidate window, before its
// LIMIT, so a stale or unprocessed embedding cannot take a slot a citable one
// needs. The remaining currency rule is `isCurrentDocumentVariant` in
// ../documents/citation.ts; this join pins that latest variant in one batch
// query and projects `requested_url` for the caller to apply it, never per hit.
// Scoped searches keep one citation per requested proceeding;
// unscoped searches keep one citation per document.
// The result window is diversified before LIMIT so one omnibus document or one
// busy proceeding cannot fill a caller's page: at most two pages per document
// and five hits per proceeding survive regardless of the requested limit.
export function searchDipEmbeddings(
  client: PrismaClient,
  input: {
    embedding: number[];
    model: string;
    documentInstruction: string;
    queryInstruction: string;
    limit: number;
    documentProceedingIds?: string[];
  },
) {
  // An empty array means "scope to no proceeding", not "unscoped"; keep the
  // scoped query so callers can deliberately return no hits.
  const proceedingIds = input.documentProceedingIds ?? null;
  const scoped = proceedingIds !== null;
  // Scoped searches allocate a quota per proceeding, so the global cap must be
  // large enough to keep every requested proceeding's share.
  const candidateLimit = proceedingIds
    ? Math.max(
        DIP_SEARCH_CANDIDATE_LIMIT,
        proceedingIds.length * DIP_SEARCH_DOCUMENTS_PER_PROCEEDING,
      )
    : DIP_SEARCH_CANDIDATE_LIMIT;
  const params: (string | number | string[] | null)[] = [
    JSON.stringify(input.embedding),
    input.model,
    input.documentInstruction,
    input.queryInstruction,
    input.limit,
    proceedingIds,
    candidateLimit,
  ];
  if (scoped) params.push(DIP_SEARCH_DOCUMENTS_PER_PROCEEDING);
  return client.$transaction(
    async (tx) => {
      await configureHnsw(tx);
      const run = (exact: boolean) =>
        tx.$queryRawUnsafe<DipSearchRow[]>(
          outerSearch(candidateWindow(scoped, exact)),
          ...params,
        );
      const rows = await run(false);
      // A filtered ANN scan can return nothing when another embedding
      // configuration supplies every nearby tuple. Scoped searches are already
      // exact; the unscoped path falls back to an exact scan rather than
      // returning an empty answer.
      if (rows.length || scoped) return rows;
      return run(true);
    },
    { timeout: 30_000 },
  );
}

// Each knob is guarded by pg_settings: older pgvector has no iterative scan and
// an unknown setting would fail the whole search.
async function configureHnsw(tx: Prisma.TransactionClient) {
  // Setting names are literals from this module, never user input.
  const set = (name: string, value: string) =>
    tx.$queryRawUnsafe(
      `SELECT set_config('${name}', $1, true)
       WHERE EXISTS (SELECT 1 FROM pg_settings WHERE name = '${name}')`,
      value,
    );
  await set("hnsw.ef_search", String(DIP_SEARCH_HNSW_EF_SEARCH));
  await set("hnsw.iterative_scan", "relaxed_order");
  await set("hnsw.max_scan_tuples", String(DIP_SEARCH_HNSW_MAX_SCAN_TUPLES));
}

// A document embedding is a candidate only when its exact variant is current,
// its stored chunk exists, and the reference still has a step to cite. URL
// currency is deliberately left to `isCurrentDocumentVariant`: a stale
// revision is still shown as metadata-only rather than dropped.
function documentEligibility() {
  return `EXISTS (
    SELECT 1
    FROM ${qualifiedTable("document_contents")} c
    JOIN ${qualifiedTable("document_chunks")} dc
      ON dc.content_id = c.id
     AND dc.page_no = e.source_page
     AND dc.chunk_no = e.source_chunk
    WHERE c.reference_id = e.source_api_id
      AND c.variant_no = e.source_version_no
      AND c.is_latest
      AND EXISTS (
        SELECT 1
        FROM ${qualifiedTable("document_references")} r
        JOIN ${qualifiedTable("proceeding_steps")} rs ON rs.api_id = r.step_id
        WHERE r.reference_id = e.source_api_id
      )
  )`;
}

function unscopedEligibility() {
  return `(
    (e.source_entity = 'vorgang' AND EXISTS (
      SELECT 1 FROM ${qualifiedTable("proceedings")} p
      WHERE p.api_id = e.source_api_id
        AND p.latest_version_no = e.source_version_no))
    OR (e.source_entity = 'vorgangsposition' AND EXISTS (
      SELECT 1 FROM ${qualifiedTable("proceeding_steps")} s
      WHERE s.api_id = e.source_api_id
        AND s.latest_version_no = e.source_version_no))
    OR (e.source_entity = 'dokument' AND ${documentEligibility()})
  )`;
}

// Every requested proceeding gets its own exact, eligible candidate list, so a
// document-heavy proceeding cannot exhaust another's window. The MATERIALIZED
// CTE keeps the ordering out of the HNSW index: this path must rank every
// eligible row, not a bounded ANN sample.
function scopedCandidateWindow() {
  return `(WITH eligible AS MATERIALIZED (
    SELECT DISTINCT ON (e.source_entity, e.source_api_id, e.source_version_no,
      e.source_page, e.source_chunk, r.proceeding_id)
      e.source_entity, e.source_api_id, e.source_version_no,
      e.source_page, e.source_chunk, e.embedding, r.proceeding_id
    FROM ${qualifiedTable("dip_embeddings")} e
    JOIN ${qualifiedTable("document_references")} r
      ON r.reference_id = e.source_api_id
    JOIN ${qualifiedTable("proceeding_steps")} rs ON rs.api_id = r.step_id
    JOIN ${qualifiedTable("document_contents")} c
      ON c.reference_id = e.source_api_id
     AND c.variant_no = e.source_version_no
     AND c.is_latest
    JOIN ${qualifiedTable("document_chunks")} dc
      ON dc.content_id = c.id
     AND dc.page_no = e.source_page
     AND dc.chunk_no = e.source_chunk
    WHERE e.model = $2 AND e.document_instruction = $3
      AND e.query_instruction = $4 AND e.source_entity = 'dokument'
      AND r.proceeding_id = ANY($6::text[])
    ORDER BY e.source_entity, e.source_api_id, e.source_version_no,
      e.source_page, e.source_chunk, r.proceeding_id
  ), allocated AS (
    SELECT eligible.*, ROW_NUMBER() OVER (
      PARTITION BY proceeding_id
      ORDER BY embedding <=> $1::public.vector, source_page, source_chunk
    ) AS proceeding_rank
    FROM eligible
  )
  SELECT source_entity, source_api_id, source_version_no, source_page,
    source_chunk, embedding
  FROM allocated
  WHERE proceeding_rank <= $8
  ORDER BY embedding <=> $1::public.vector
  LIMIT $7)`;
}

function exactCandidateWindow() {
  return `(WITH eligible AS MATERIALIZED (
    SELECT e.source_entity, e.source_api_id, e.source_version_no,
      e.source_page, e.source_chunk, e.embedding
    FROM ${qualifiedTable("dip_embeddings")} e
    WHERE e.model = $2 AND e.document_instruction = $3
      AND e.query_instruction = $4 AND ${unscopedEligibility()}
  )
  SELECT * FROM eligible
  ORDER BY embedding <=> $1::public.vector
  LIMIT $7)`;
}

function annCandidateWindow() {
  return `(SELECT e.source_entity, e.source_api_id, e.source_version_no,
    e.source_page, e.source_chunk, e.embedding
    FROM ${qualifiedTable("dip_embeddings")} e
    WHERE e.model = $2 AND e.document_instruction = $3
      AND e.query_instruction = $4 AND ${unscopedEligibility()}
    ORDER BY e.embedding <=> $1::public.vector
    LIMIT $7)`;
}

function candidateWindow(scoped: boolean, exact: boolean) {
  if (scoped) return scopedCandidateWindow();
  return exact ? exactCandidateWindow() : annCandidateWindow();
}

function outerSearch(window: string) {
  return `SELECT * FROM (
     SELECT capped.*, ROW_NUMBER() OVER (
       PARTITION BY CASE WHEN "entity" = 'vorgang' THEN "apiId" ELSE "proceedingApiId" END
       ORDER BY "score" DESC, "sortEntity", "apiId", "pageNo"
     ) AS "proceedingRank"
     FROM (
     SELECT ranked.*, ROW_NUMBER() OVER (
       PARTITION BY "entity", "apiId", "proceedingApiId" ORDER BY "score" DESC, "pageNo"
     ) AS "documentRank"
     FROM (
     SELECT e.source_entity::text AS "entity", e.source_api_id AS "apiId",
      e.source_entity AS "sortEntity",
      e.source_version_no AS "versionNo",
      1 - (e.embedding <=> $1::public.vector) AS "score",
      ROW_NUMBER() OVER (
        PARTITION BY e.source_entity, e.source_api_id, e.source_page, dr.proceeding_id
        ORDER BY e.embedding <=> $1::public.vector, e.source_chunk
      ) AS "pageRank",
      CASE WHEN e.source_entity = 'dokument' THEN dr.document_number
        ELSE COALESCE(p.title, s.title) END AS "title",
      COALESCE(p.metadata->>'abstract', s.metadata->>'abstract') AS "summary",
      s.step_label AS "stepLabel",
      COALESCE(s.proceeding_id, dr.proceeding_id) AS "proceedingApiId",
      dr.reference_id AS "referenceId",
      dr.document_number AS "documentNumber",
      dr.pdf_url AS "pdfUrl",
      dr.requested_url AS "requestedUrl",
      dr.institution AS "institution",
      dr.document_type AS "documentType",
      dr.metadata AS "referenceMetadata",
      dr.step_id AS "stepId",
      CASE WHEN e.source_entity = 'dokument' THEN e.source_page END AS "pageNo",
      CASE WHEN e.source_entity = 'dokument' THEN e.source_chunk END AS "chunkNo",
      dc.text AS "passage",
      sec."sectionLabel",
      sec."sectionTitle",
      sec."sectionStartPage",
      sec."sectionEndPage"
     FROM ${window} e
     LEFT JOIN ${qualifiedTable("proceedings")} p
       ON e.source_entity = 'vorgang' AND p.api_id = e.source_api_id
       AND p.latest_version_no = e.source_version_no
     LEFT JOIN ${qualifiedTable("proceeding_steps")} s
       ON e.source_entity = 'vorgangsposition' AND s.api_id = e.source_api_id
       AND s.latest_version_no = e.source_version_no
     LEFT JOIN LATERAL (
       SELECT DISTINCT ON (CASE WHEN $6::text[] IS NOT NULL THEN r.proceeding_id END)
         r.reference_id, r.document_number, r.pdf_url, r.step_id,
         r.proceeding_id, r.metadata, rs.institution, rs.document_type,
         c.requested_url,
         c.id AS content_id
       FROM ${qualifiedTable("document_references")} r
       JOIN ${qualifiedTable("proceeding_steps")} rs ON rs.api_id = r.step_id
       -- Current citation: latest variant only; the requested_url check is
       -- isCurrentDocumentVariant in ../documents/citation.ts.
       JOIN ${qualifiedTable("document_contents")} c
         ON c.reference_id = r.reference_id
         AND c.variant_no = e.source_version_no AND c.is_latest
       WHERE e.source_entity = 'dokument' AND r.reference_id = e.source_api_id
         AND ($6::text[] IS NULL OR r.proceeding_id = ANY($6::text[]))
       ORDER BY CASE WHEN $6::text[] IS NOT NULL THEN r.proceeding_id END,
         r.observed_at DESC, r.step_id
     ) dr ON true
     LEFT JOIN ${qualifiedTable("document_chunks")} dc
       ON e.source_entity = 'dokument' AND dc.content_id = dr.content_id
       AND dc.page_no = e.source_page AND dc.chunk_no = e.source_chunk
     LEFT JOIN LATERAL (
       -- Page-only provenance cannot distinguish passages from sections that
       -- share a page, so leave those passages without a section citation.
       SELECT ds.label AS "sectionLabel", ds.title AS "sectionTitle",
         ds.start_page AS "sectionStartPage", ds.end_page AS "sectionEndPage"
       FROM ${qualifiedTable("document_sections")} ds
       WHERE e.source_entity = 'dokument' AND ds.content_id = dr.content_id
         AND e.source_page BETWEEN ds.start_page AND ds.end_page
         AND NOT EXISTS (
           SELECT 1 FROM ${qualifiedTable("document_sections")} other
           WHERE other.content_id = ds.content_id AND other.section_no <> ds.section_no
             AND e.source_page BETWEEN other.start_page AND other.end_page
         )
       LIMIT 1
     ) sec ON true
     WHERE p.api_id IS NOT NULL OR s.api_id IS NOT NULL OR dc.content_id IS NOT NULL
     ) ranked
     WHERE "pageRank" = 1
     ) capped
     -- shortcut: two pages per document bound repeated evidence; increase if a document needs more context.
     WHERE "entity" <> 'dokument' OR "documentRank" <= 2
     ) diversified
     -- shortcut: five hits per proceeding keep the candidate window diverse; increase for deeper dossiers.
     WHERE "proceedingRank" <= 5
     ORDER BY "score" DESC, "sortEntity", "apiId"
     LIMIT $5`;
}
