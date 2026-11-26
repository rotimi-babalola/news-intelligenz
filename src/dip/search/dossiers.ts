import type { PrismaClient } from "../../generated/prisma/client";
import { getProceedings } from "../proceedings/timeline";
import {
  addDocumentEvidence,
  buildDossiers,
  hasCitablePageEvidence,
} from "./dossier-builders";
import { embedText } from "./embedding";
import { searchDip } from "./search";

export async function searchProceedingDossiers(
  prisma: PrismaClient,
  query: string,
  limit: number,
) {
  const embedding = await embedText(query, "query");
  // The search transaction holds the HNSW candidate-list setting and a timeout
  // wide enough for a no-index scan. `isCurrent` drops hits that changed meanwhile.
  const hits = await searchDip(prisma, query, Math.max(100, limit * 5), {
    embed: async () => embedding,
  });
  const ids = [
    ...new Set(
      hits
        .map((hit) =>
          hit.entity === "vorgang" ? hit.apiId : hit.proceedingApiId,
        )
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const dossiers = buildDossiers(
    hits,
    await getProceedings(prisma, ids),
    limit,
  );
  const missing = dossiers
    .filter((dossier) => !hasCitablePageEvidence(dossier.evidence))
    .map((dossier) => dossier.apiId);
  if (!missing.length) return dossiers;
  // Step hits can fill the global window before a relevant PDF page appears.
  // The query allocates candidates per requested proceeding, so a
  // document-heavy proceeding cannot exhaust another's share.
  const documents = await searchDip(prisma, query, missing.length * 5, {
    embed: async () => embedding,
    documentProceedingIds: missing,
  });
  return addDocumentEvidence(dossiers, documents);
}
