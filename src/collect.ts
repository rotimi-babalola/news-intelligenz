import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { parseFeed, type Candidate } from "./feed.js";
import {
  canonicalArticleUrl,
  normalizeIdentifierValue,
  normalizePublisher,
} from "./identity.js";
import {
  configuredFeed,
  fetchFeedXml,
  publicNewsFeeds,
  type Feed,
} from "./sources.js";

export type FeedResult = {
  feedId: string;
  runId: string;
  status: "completed" | "failed";
  valid: number;
  invalid: number;
  error?: string;
};

export async function collect(
  prisma: PrismaClient,
  runId: string,
  xml: string,
  feed: Feed = configuredFeed,
) {
  if (!runId.trim() || runId.length > 200)
    throw new Error("Run ID must contain 1–200 characters");
  const hash = createHash("sha256").update(xml).digest("hex");
  return prisma.$transaction(async (tx) => {
    // One configured collector; serialize identity resolution and concurrent replay.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8135421)`;
    const previous = await tx.run.findUnique({ where: { id: runId } });
    if (previous) {
      if (previous.inputHash !== hash || previous.feedId !== feed.id)
        throw new Error(
          "Run ID already belongs to a different input; use a new run ID",
        );
      return previous;
    }
    await tx.run.create({
      data: { id: runId, feedId: feed.id, inputHash: hash, status: "running" },
    });
    let candidates: Candidate[] = [];
    let parseError: string | null = null;
    try {
      candidates = parseFeed(xml, feed.defaultLanguage);
    } catch (error) {
      parseError =
        error instanceof Error ? error.message : "Feed parsing failed";
    }
    let valid = 0;
    for (const [index, candidate] of candidates.entries()) {
      const { errors, ...metadata } = candidate;
      let publicationId: string | null = null;
      if (!errors.length) {
        // The parser only emits valid candidates with a de|en language;
        // fail loudly instead of persisting anything else.
        const language = candidate.language;
        if (language !== "de" && language !== "en")
          throw new Error(`Unexpected candidate language: ${language}`);
        // Identity scope is the normalized publisher; URL aliases resolve to
        // one canonical key while the raw original URL stays on the row.
        const publisher = normalizePublisher(feed.publisher);
        const urlKey = canonicalArticleUrl(candidate.originalUrl);
        const guidKey = normalizeIdentifierValue(candidate.sourceId);
        const keys = [
          urlKey ? { kind: "url" as const, value: urlKey } : null,
          guidKey ? { kind: "guid" as const, value: guidKey } : null,
        ].filter((k) => k !== null);
        const matches = keys.length
          ? await tx.publicationIdentifier.findMany({
              where: { publisher, OR: keys },
              select: { publicationId: true },
            })
          : [];
        const identities = new Set(matches.map((m) => m.publicationId));
        if (identities.size > 1)
          errors.push(
            "Conflicting publication identities; manual inspection required",
          );
        else {
          publicationId = [...identities][0] ?? randomUUID();
          const publication: Prisma.PublicationUncheckedCreateInput = {
            id: publicationId,
            publisher,
            headline: candidate.headline,
            originalUrl: candidate.originalUrl,
            publishedAt: candidate.publishedAt,
            language,
          };
          await tx.publication.upsert({
            where: { id: publicationId },
            create: publication,
            update: {
              headline: candidate.headline,
              originalUrl: candidate.originalUrl,
              publishedAt: candidate.publishedAt,
              language,
              lastDiscoveredAt: new Date(),
            },
          });
          for (const { kind, value } of keys) {
            await tx.publicationIdentifier.upsert({
              where: {
                publisher_kind_value: {
                  publisher,
                  kind,
                  value,
                },
              },
              create: {
                publisher,
                kind,
                value,
                publicationId,
              },
              update: {},
            });
          }
          await tx.discovery.upsert({
            where: { runId_publicationId: { runId, publicationId } },
            create: { runId, publicationId },
            update: {},
          });
          valid++;
        }
      }
      await tx.candidate.create({
        data: {
          runId,
          itemIndex: index,
          metadata,
          errors,
          publicationId,
        },
      });
    }
    return tx.run.update({
      where: { id: runId },
      data: {
        status: parseError ? "failed" : "completed",
        completedAt: new Date(),
        validCount: valid,
        invalidCount: candidates.length - valid,
        error: parseError,
      },
    });
  });
}

async function recordFeedFailure(
  prisma: PrismaClient,
  runId: string,
  feed: Feed,
  message: string,
) {
  const inputHash = createHash("sha256")
    .update(`fetch-failure:${feed.id}:${feed.url}`)
    .digest("hex");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8135421)`;
    const previous = await tx.run.findUnique({ where: { id: runId } });
    if (previous) return previous;
    return tx.run.create({
      data: {
        id: runId,
        feedId: feed.id,
        inputHash,
        status: "failed",
        completedAt: new Date(),
        validCount: 0,
        invalidCount: 0,
        error: message,
      },
    });
  });
}

export async function collectAll(
  prisma: PrismaClient,
  runPrefix: string,
  fetchXml: (url: string) => Promise<string> = fetchFeedXml,
  feeds: Feed[] = publicNewsFeeds,
): Promise<FeedResult[]> {
  if (!runPrefix.trim() || runPrefix.length > 100)
    throw new Error("Run prefix must contain 1–100 characters");
  const results: FeedResult[] = [];
  for (const feed of feeds) {
    const runId = `${runPrefix}:${feed.id}`;
    if (!feed.url) {
      const error = "Feed has no live URL";
      await recordFeedFailure(prisma, runId, feed, error);
      results.push({
        feedId: feed.id,
        runId,
        status: "failed",
        error,
        valid: 0,
        invalid: 0,
      });
      continue;
    }
    try {
      const xml = await fetchXml(feed.url);
      const run = await collect(prisma, runId, xml, feed);
      // collect() never returns a "running" run; error presence marks failure.
      const status = run.error ? "failed" : "completed";
      results.push({
        feedId: feed.id,
        runId,
        status,
        valid: run.validCount,
        invalid: run.invalidCount,
        ...(run.error ? { error: run.error } : {}),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Feed collection failed";
      try {
        await recordFeedFailure(prisma, runId, feed, message);
      } catch {
        // Failure bookkeeping must not hide the original error.
      }
      results.push({
        feedId: feed.id,
        runId,
        status: "failed",
        error: message,
        valid: 0,
        invalid: 0,
      });
    }
  }
  return results;
}
