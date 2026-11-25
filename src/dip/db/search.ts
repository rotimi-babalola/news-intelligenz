import type {
  ParliamentaryEntity,
  Prisma,
  PrismaClient,
} from "../../generated/prisma/client";
import { qualifiedTable } from "../../db";
import {
  DIP_SEARCH_CANDIDATE_LIMIT,
  DIP_SEARCH_HNSW_EF_SEARCH,
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
// duplicate hits. The currency rule is `isCurrentDocumentVariant` in
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
  // The scoped follow-up ranks exactly within the requested proceedings: an ANN
  // scan filters after collecting its candidate list, so a narrow scope could
  // return nothing. The unscoped search keeps the ANN candidate window.
  const candidateWindow = input.documentProceedingIds
    ? `(WITH scoped AS MATERIALIZED (
         SELECT e.source_entity, e.source_api_id, e.source_version_no,
           e.source_page, e.source_chunk, e.embedding
         FROM ${qualifiedTable("dip_embeddings")} e
         WHERE e.model = $2 AND e.document_instruction = $3
           AND e.query_instruction = $4 AND e.source_entity = 'dokument'
           AND EXISTS (
             SELECT 1 FROM ${qualifiedTable("document_references")} r
             WHERE r.reference_id = e.source_api_id
               AND r.proceeding_id = ANY($6::text[])
           )
       )
       SELECT * FROM scoped
       ORDER BY embedding <=> $1::public.vector
       LIMIT $7)`
    : `(SELECT e.source_entity, e.source_api_id, e.source_version_no,
         e.source_page, e.source_chunk, e.embedding
       FROM ${qualifiedTable("dip_embeddings")} e
       WHERE e.model = $2 AND e.document_instruction = $3
         AND e.query_instruction = $4
         AND ($6::text[] IS NULL OR e.source_entity = 'dokument')
       ORDER BY e.embedding <=> $1::public.vector
       LIMIT $7)`;
  return client.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT set_config('hnsw.ef_search', $1, true)",
        String(DIP_SEARCH_HNSW_EF_SEARCH),
      );
      return tx.$queryRawUnsafe<DipSearchRow[]>(
        `SELECT * FROM (
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
     FROM ${candidateWindow} e
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
     LIMIT $5`,
        JSON.stringify(input.embedding),
        input.model,
        input.documentInstruction,
        input.queryInstruction,
        input.limit,
        input.documentProceedingIds ?? null,
        DIP_SEARCH_CANDIDATE_LIMIT,
      );
    },
    { timeout: 30_000 },
  );
}
