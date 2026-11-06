import type { PrismaClient } from "../generated/prisma/client";
import {
  assertEmbedding,
  embeddingConfig,
  embeddingInput,
  embedText,
  QUERY_INSTRUCTION,
} from "./embedding";
import { searchDipEmbeddings } from "./repository";
import { readDocumentExcerpt } from "./excerpts";

export { QUERY_INSTRUCTION };

export async function searchDip(
  prisma: PrismaClient,
  query: string,
  limit: number,
  options: { embed?: (text: string) => Promise<number[]> } = {},
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
  });
  return rows.map((row) => {
    const endpoint =
      row.entity === "vorgang" ? "/vorgang" : "/vorgangsposition";
    if (row.entity === "dokument") {
      const stepApiId = row.stepId ?? "";
      const excerpt =
        row.requestedUrl !== row.pdfUrl
          ? {
              status: "metadata-only" as const,
              reason: "Document revision has not been processed",
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
        },
        source: {
          endpoint,
          apiId: stepApiId,
          url:
            row.pdfUrl ??
            `https://search.dip.bundestag.de/api/v1${endpoint}/${stepApiId}`,
        },
      };
    }
    return {
      entity: row.entity,
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
        url: `https://search.dip.bundestag.de/api/v1${endpoint}/${row.apiId}`,
      },
    };
  });
}
