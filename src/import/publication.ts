import { randomUUID } from "node:crypto";
import type { IdentifierKind, Prisma } from "../generated/prisma/client";
import {
  canonicalArticleUrl,
  normalizeIdentifierValue,
  normalizePublisher,
} from "../identity";
import { enqueueJob, type EnqueueSpec, type SourceRef } from "../jobs/index";
import type {
  PublicationResolution,
  PublicationResolutionInput,
} from "./types";

export const RESOLVE_PUBLICATION = "resolve_publication";
export const EXTRACT_TEXT = "extract_publication_text";

// The extraction job inherits the parent discovery's source, so a search
// discovery keeps sourceKind search_query (with its query scope) instead of
// falling back to news_feed. An operator retry reuses this identity with its
// own dedupe key.
export function extractionJobSpec(input: {
  source: SourceRef;
  runId: string;
  itemIndex: number | null;
  publicationId: string;
  publisher: string;
  dedupeKey?: string;
}): EnqueueSpec {
  return {
    source: input.source,
    runId: input.runId,
    itemIndex: input.itemIndex,
    ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
    operation: EXTRACT_TEXT,
    payload: {
      publicationId: input.publicationId,
      publisher: input.publisher,
    },
  };
}

// Single seam for publication identity: publisher-scoped URL/guid matching,
// publication + identifier + discovery writes, and extraction handoff share
// one transaction so RSS and search callers converge instead of duplicating
// policy. Parliamentary proceedings/steps stay separate (ADR 0004);
// publication versions stay under their publication (ADR 0001).
export async function resolvePublication(
  tx: Prisma.TransactionClient,
  input: PublicationResolutionInput,
): Promise<PublicationResolution> {
  const publisher = normalizePublisher(input.rawPublisher);
  // Serialize resolution per publisher: two workers resolving the same
  // article concurrently would both miss, then both insert, and the loser's
  // identifier upsert would silently keep its orphan publication.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${publisher}))`;
  const urlKey = canonicalArticleUrl(input.originalUrl);
  const guidKey = normalizeIdentifierValue(input.sourceId);
  const keys = [
    urlKey ? { kind: "url" as const, value: urlKey } : null,
    guidKey ? { kind: "guid" as const, value: guidKey } : null,
  ].filter((k): k is { kind: IdentifierKind; value: string } => k !== null);
  const matches = keys.length
    ? await tx.publicationIdentifier.findMany({
        where: { publisher, OR: keys },
        select: { publicationId: true },
      })
    : [];
  const identities = new Set(matches.map((m) => m.publicationId));
  if (identities.size > 1)
    return {
      publicationId: null,
      errors: [
        "Conflicting publication identities; manual inspection required",
      ],
    };
  const publicationId = [...identities][0] ?? randomUUID();
  await tx.publication.upsert({
    where: { id: publicationId },
    create: {
      id: publicationId,
      publisher,
      headline: input.headline,
      originalUrl: input.originalUrl,
      publishedAt: input.publishedAt,
      language: input.language,
    },
    update: {
      headline: input.headline,
      publishedAt: input.publishedAt,
      language: input.language,
      lastDiscoveredAt: new Date(),
    },
  });
  for (const { kind, value } of keys) {
    await tx.publicationIdentifier.upsert({
      where: { publisher_kind_value: { publisher, kind, value } },
      create: { publisher, kind, value, publicationId },
      update: {},
    });
  }
  await tx.discovery.upsert({
    where: {
      runId_publicationId: { runId: input.runId, publicationId },
    },
    create: { runId: input.runId, publicationId },
    update: {},
  });
  await enqueueJob(
    tx,
    extractionJobSpec({
      source: input.source,
      runId: input.runId,
      itemIndex: input.itemIndex,
      publicationId,
      publisher,
    }),
  );
  return { publicationId, errors: [] };
}
