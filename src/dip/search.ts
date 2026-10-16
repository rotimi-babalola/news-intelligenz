import type { PrismaClient } from "../generated/prisma/client";
import {
  assertEmbedding,
  DOCUMENT_INSTRUCTION,
  embedText,
  EMBEDDING_MODEL,
  QUERY_INSTRUCTION,
} from "./embedding";
import { searchDipEmbeddings } from "./repository";

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
    queryInstruction: QUERY_INSTRUCTION,
    limit,
  });
  return rows.map((row) => {
    const endpoint =
      row.entity === "vorgang" ? "/vorgang" : "/vorgangsposition";
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
