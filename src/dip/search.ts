import type { PrismaClient } from "../generated/prisma/client";
import {
  assertEmbedding,
  DOCUMENT_INSTRUCTION,
  embedText,
  EMBEDDING_MODEL,
} from "./embedding";
import { searchDipEmbeddings } from "./repository";

export const QUERY_INSTRUCTION =
  "Given a German or English query, retrieve relevant German parliamentary proceedings and steps";

export async function searchDip(
  prisma: PrismaClient,
  query: string,
  limit: number,
  options: { embed?: (text: string) => Promise<number[]> } = {},
) {
  const embedding = await (options.embed ?? embedText)(
    `Instruct: ${QUERY_INSTRUCTION}\nQuery:${query}`,
  );
  assertEmbedding(embedding);
  const rows = await searchDipEmbeddings(prisma, {
    embedding,
    model: EMBEDDING_MODEL,
    documentInstruction: DOCUMENT_INSTRUCTION,
    limit,
  });
  return rows.map((row) => {
    const endpoint =
      row.entity === "vorgang" ? "/vorgang" : "/vorgangsposition";
    if (row.entity === "dokument") {
      const stepApiId = row.stepId ?? "";
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
      ...row,
      source: {
        endpoint,
        apiId: row.apiId,
        url: `https://search.dip.bundestag.de/api/v1${endpoint}/${row.apiId}`,
      },
    };
  });
}
