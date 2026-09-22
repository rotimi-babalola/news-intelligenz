import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { parseFeed, type Candidate } from "./feed.js";
import { configuredFeed, type Feed } from "./sources.js";

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
        const matches = await tx.publicationIdentifier.findMany({
          where: {
            publisher: feed.publisher,
            OR: [
              { kind: "url", value: candidate.originalUrl },
              { kind: "guid", value: candidate.sourceId },
            ],
          },
          select: { publicationId: true },
        });
        const identities = new Set(matches.map((m) => m.publicationId));
        if (identities.size > 1)
          errors.push(
            "Conflicting publication identities; manual inspection required",
          );
        else {
          publicationId = [...identities][0] ?? randomUUID();
          const publication: Prisma.PublicationUncheckedCreateInput = {
            id: publicationId,
            publisher: feed.publisher,
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
          for (const [kind, value] of [
            ["url", candidate.originalUrl],
            ["guid", candidate.sourceId],
          ] as const) {
            if (value)
              await tx.publicationIdentifier.upsert({
                where: {
                  publisher_kind_value: {
                    publisher: feed.publisher,
                    kind,
                    value,
                  },
                },
                create: {
                  publisher: feed.publisher,
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
