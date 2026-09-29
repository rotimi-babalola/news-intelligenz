import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { parseFeed, type Candidate } from "./feed.js";
import {
  canonicalArticleUrl,
  normalizeIdentifierValue,
  normalizePublisher,
} from "./identity.js";
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  feedSource,
  type ClaimedJob,
} from "./jobs.js";
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

export const RESOLVE_PUBLICATION = "resolve_publication";

type Intake = {
  runId: string;
  parseError: string | null;
  settled: boolean;
};

// Durable discovery handoff: the run, its candidates and one processing job
// per parse-valid candidate commit in a single transaction. Publication,
// identifier and discovery writes happen later, one transaction per job, so a
// crash between handoff and processing resumes without losing encounters.
export async function collectIntake(
  prisma: PrismaClient,
  runId: string,
  xml: string,
  feed: Feed = configuredFeed,
): Promise<Intake> {
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
      return {
        runId: previous.id,
        parseError: previous.error,
        settled: previous.completedAt !== null,
      };
    }
    await tx.run.create({
      data: {
        id: runId,
        feedId: feed.id,
        sourceKind: "news_feed",
        inputHash: hash,
        status: "running",
      },
    });
    let candidates: Candidate[] = [];
    let parseError: string | null = null;
    try {
      candidates = parseFeed(xml, feed.defaultLanguage);
    } catch (error) {
      parseError =
        error instanceof Error ? error.message : "Feed parsing failed";
    }
    for (const [index, candidate] of candidates.entries()) {
      const { errors, ...metadata } = candidate;
      await tx.candidate.create({
        data: { runId, itemIndex: index, metadata, errors },
      });
      if (!errors.length) {
        await enqueueJob(tx, {
          source: feedSource(feed.id),
          runId,
          itemIndex: index,
          operation: RESOLVE_PUBLICATION,
          payload: { itemIndex: index, publisher: feed.publisher },
        });
      }
    }
    return { runId, parseError, settled: false };
  });
}

// Commit boundary: one candidate's publication, identifiers, discovery
// encounter and candidate link commit together. Every write is an idempotent
// upsert keyed by identity or (run, publication), so a retried job never
// duplicates committed records.
export async function processJob(
  prisma: PrismaClient,
  job: ClaimedJob,
): Promise<void> {
  if (job.operation !== RESOLVE_PUBLICATION || job.itemIndex === null)
    throw new Error(`Unknown job operation: ${job.operation}`);
  const payload = job.payload as { publisher?: unknown };
  const rawPublisher = payload.publisher;
  if (typeof rawPublisher !== "string")
    throw new Error("Publication job is missing its publisher");
  await prisma.$transaction(async (tx) => {
    const candidate = await tx.candidate.findUnique({
      where: { runId_itemIndex: { runId: job.runId, itemIndex: job.itemIndex! } },
    });
    if (!candidate) throw new Error("Candidate for job no longer exists");
    const errors = [...(candidate.errors as string[])];
    const metadata = candidate.metadata as {
      headline: string;
      originalUrl: string;
      sourceId: string;
      language: string;
      publishedAt: string | null;
    };
    let publicationId: string | null = null;
    if (!errors.length) {
      // The parser only emits valid candidates with a de|en language;
      // fail loudly instead of persisting anything else.
      const language = metadata.language;
      if (language !== "de" && language !== "en")
        throw new Error(`Unexpected candidate language: ${language}`);
      // Identity scope is the normalized publisher; URL aliases resolve to
      // one canonical key while the raw original URL stays on the row.
      const publisher = normalizePublisher(rawPublisher);
      // Serialize resolution per publisher: two workers resolving the same
      // article concurrently would both miss, then both insert, and the
      // loser's identifier upsert would silently keep its orphan publication.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${publisher}))`;
      const urlKey = canonicalArticleUrl(metadata.originalUrl);
      const guidKey = normalizeIdentifierValue(metadata.sourceId);
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
          headline: metadata.headline,
          originalUrl: metadata.originalUrl,
          publishedAt: metadata.publishedAt,
          language,
        };
        await tx.publication.upsert({
          where: { id: publicationId },
          create: publication,
          update: {
            headline: metadata.headline,
            publishedAt: metadata.publishedAt,
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
          where: {
            runId_publicationId: { runId: job.runId, publicationId },
          },
          create: { runId: job.runId, publicationId },
          update: {},
        });
      }
    }
    await tx.candidate.update({
      where: { runId_itemIndex: { runId: job.runId, itemIndex: job.itemIndex! } },
      data: { errors, publicationId },
    });
  });
}

// A worker pass: claim ready jobs one at a time until none remain claimable
// now. One job's failure is recorded on that job and never stops the rest,
// so independent sources keep moving while a failing source backs off.
export async function drainJobs(
  prisma: PrismaClient,
  workerId: string,
  filter: { runId?: string } = {},
) {
  const outcome = { succeeded: 0, retrying: 0, exhausted: 0 };
  for (;;) {
    const job = await claimNextJob(prisma, workerId, undefined, filter);
    if (!job) return outcome;
    try {
      await processJob(prisma, job);
      await completeJob(prisma, job, workerId);
      outcome.succeeded++;
    } catch (error) {
      const { exhausted } = await failJob(
        prisma,
        job,
        workerId,
        error instanceof Error ? error : new Error("Job processing failed"),
      );
      if (exhausted) outcome.exhausted++;
      else outcome.retrying++;
    }
  }
}

export async function finalizeRunIfSettled(
  prisma: PrismaClient,
  runId: string,
  parseError: string | null,
) {
  const open = await prisma.processingJob.count({
    where: { runId, status: { in: ["pending", "claimed", "retrying"] } },
  });
  if (open > 0) return prisma.run.findUniqueOrThrow({ where: { id: runId } });
  const candidates = await prisma.candidate.findMany({
    where: { runId },
    select: { errors: true },
  });
  const valid = candidates.filter(
    (c) => (c.errors as unknown[]).length === 0,
  ).length;
  return prisma.run.update({
    where: { id: runId },
    data: {
      status: parseError ? "failed" : "completed",
      completedAt: new Date(),
      validCount: valid,
      invalidCount: candidates.length - valid,
      error: parseError,
    },
  });
}

export async function collect(
  prisma: PrismaClient,
  runId: string,
  xml: string,
  feed: Feed = configuredFeed,
) {
  const intake = await collectIntake(prisma, runId, xml, feed);
  if (intake.settled)
    return prisma.run.findUniqueOrThrow({ where: { id: runId } });
  await drainJobs(prisma, `collect:${runId}`, { runId });
  return finalizeRunIfSettled(prisma, runId, intake.parseError);
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
        sourceKind: "news_feed",
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
