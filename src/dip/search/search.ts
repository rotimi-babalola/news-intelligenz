import {
  assertEmbedding,
  embeddingConfig,
  embeddingInput,
  embedText,
} from "./embedding";
import { QUERY_INSTRUCTION } from "../constants";
import { searchDipEmbeddings } from "../db/index";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  isCurrentDocumentVariant,
  STALE_REVISION_REASON,
} from "../documents/citation";
import { readDocumentExcerpt } from "../documents/excerpts";
import { toSection } from "../documents/sections";

export { QUERY_INSTRUCTION };

import { DIP_API_BASE_URL } from "../constants";

export async function searchDip(
  prisma: PrismaClient,
  query: string,
  limit: number,
  options: {
    embed?: (text: string) => Promise<number[]>;
    documentProceedingIds?: string[];
  } = {},
) {
  const config = embeddingConfig();
  const embedding = options.embed
    ? await options.embed(embeddingInput(query, "query", config))
    : await embedText(query, "query");
  assertEmbedding(embedding);
  const rows = await searchDipEmbeddings(prisma, {
    embedding,
    model: config.indexId,
    documentInstruction: config.documentInstruction,
    queryInstruction: config.queryInstruction,
    limit,
    documentProceedingIds: options.documentProceedingIds,
  });
  return rows.map((row) => {
    const endpoint =
      row.entity === "vorgang" ? "/vorgang" : "/vorgangsposition";
    if (row.entity === "dokument") {
      const stepApiId = row.stepId ?? "";
      const excerpt = !isCurrentDocumentVariant(row.requestedUrl, row.pdfUrl)
        ? {
            status: "metadata-only" as const,
            reason: STALE_REVISION_REASON,
          }
        : readDocumentExcerpt(
            {
              institution: row.institution,
              documentType: row.documentType,
              documentNumber: row.documentNumber,
              pdfUrl: row.pdfUrl,
              metadata: row.referenceMetadata,
            },
            row.pageNo,
            row.passage,
          );
      return {
        entity: row.entity,
        apiId: row.apiId,
        versionNo: row.versionNo,
        score: row.score,
        title: row.documentNumber,
        summary: null,
        stepLabel: null,
        proceedingApiId: row.proceedingApiId,
        page: row.pageNo,
        chunk: row.chunkNo,
        passage: excerpt.status === "excerpt-eligible" ? excerpt.text : null,
        excerpt,
        document: {
          referenceId: row.referenceId ?? row.apiId,
          number: row.documentNumber,
          page: row.pageNo,
          pdfUrl: row.pdfUrl,
          section:
            excerpt.status === "excerpt-eligible"
              ? toSection({
                  label: row.sectionLabel,
                  title: row.sectionTitle,
                  startPage: row.sectionStartPage,
                  endPage: row.sectionEndPage,
                })
              : null,
        },
        source: {
          endpoint,
          apiId: stepApiId,
          url: row.pdfUrl ?? `${DIP_API_BASE_URL}${endpoint}/${stepApiId}`,
        },
      };
    }
    const record = {
      apiId: row.apiId,
      versionNo: row.versionNo,
      score: row.score,
      title: row.title,
      summary: row.summary,
      stepLabel: row.stepLabel,
      proceedingApiId: row.proceedingApiId,
      source: {
        endpoint,
        apiId: row.apiId,
        url: `${DIP_API_BASE_URL}${endpoint}/${row.apiId}`,
      },
    };
    return row.entity === "vorgang"
      ? { entity: "vorgang" as const, ...record }
      : { entity: "vorgangsposition" as const, ...record };
  });
}

export type DipHit = Awaited<ReturnType<typeof searchDip>>[number];
