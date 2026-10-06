import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "../generated/prisma/client";
import { parseFeed, type Candidate } from "../feed";
import { extractArticleText, fetchArticleHtml } from "../extract";
import {
  recordExtractionFailure,
  storeExtractedText,
} from "../extract/repository";
import {
  canonicalArticleUrl,
  normalizeIdentifierValue,
  normalizePublisher,
} from "../identity";
import {
  claimNextJob,
  completeJob,
  countOpenJobs,
  dedupeKey,
  enqueueJob,
  failJob,
  feedSource,
  requeueStaleClaims,
  retryExhausted,
  searchSource,
  type ClaimedJob,
} from "../jobs";
import {
  configuredFeed,
  fetchFeedXml,
  fixtureFeed,
  publicNewsFeeds,
  type Feed,
} from "../sources";
import {
  createCandidate,
  getCandidate,
  listCandidatesForTally,
  updateCandidateResult,
} from "./candidate.repository";
import {
  searchAllowedDomains,
  assessRelevance,
  toSearchCandidates,
  type SearchProvider,
  type SearchResult,
} from "../search";
import { fetchProviderResults } from "../search-providers";
import { upsertDiscovery } from "./discovery.repository";
import { getReview, upsertReview } from "./relevance.repository";
import {
  findPublicationIdsByKeys,
  upsertIdentifier,
  upsertPublication,
  type IdentityKey,
} from "./publication.repository";
import {
  createRun,
  finalizeRun,
  findRun,
  findRunOrThrow,
} from "./run.repository";
import {
  countProviderCallsSince,
  isPermanentFailure,
  monthStartUtc,
  providerBudget,
  recordFeedFailure,
  summarizeFeed,
} from "./util";
import type {
  ArticleFetcher,
  FeedResult,
  Intake,
  SearchCollectionOptions,
  SearchCollectionResult,
} from "./types";

export type {
  ArticleFetcher,
  FeedResult,
  SearchCollectionOptions,
  SearchCollectionResult,
} from "./types";

export const RESOLVE_PUBLICATION = "resolve_publication";
export const EXTRACT_TEXT = "extract_publication_text";

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
    const previous = await findRun(tx, runId);
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
    // Parse before creating the run so a crash after intake-commit still
    // leaves the failure persisted for the resumed finalize.
    let candidates: Candidate[] = [];
    let parseError: string | null = null;
    try {
      candidates = parseFeed(xml, feed.defaultLanguage);
    } catch (error) {
      parseError =
        error instanceof Error ? error.message : "Feed parsing failed";
    }
    await createRun(tx, {
      id: runId,
      feedId: feed.id,
      sourceKind: "news_feed",
      inputHash: hash,
      status: "running",
      error: parseError,
    });
    for (const [index, candidate] of candidates.entries()) {
      const { errors, ...metadata } = candidate;
      await createCandidate(tx, { runId, itemIndex: index, metadata, errors });
      if (!errors.length) {
        await enqueueJob(tx, {
          source: feedSource(feed.id),
          runId,
          itemIndex: index,
          operation: RESOLVE_PUBLICATION,
          payload: {
            itemIndex: index,
            publisher: feed.publisher,
            feedId: feed.id,
          },
        });
      }
    }
    return { runId, parseError, settled: false };
  });
}

// Search discovery handoff: same durable shape as feed intake (run,
// candidates, one resolve job per allowlisted candidate) with
// query/provider/rank provenance on the run scope, candidate metadata and
// job payload. Identity resolution reuses processJob unchanged: the
// RSS-consistent publisher label lets search discoveries converge onto
// feed-discovered publications instead of forking duplicates.
export async function collectSearchIntake(
  prisma: PrismaClient,
  runId: string,
  query: string,
  provider: SearchProvider,
  results: SearchResult[],
): Promise<Intake> {
  if (!runId.trim() || runId.length > 200)
    throw new Error("Run ID must contain 1–200 characters");
  if (!query.trim()) throw new Error("Search query must not be empty");
  const candidates = toSearchCandidates(results, query, provider);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({ query, provider, urls: results.map((r) => r.url) }),
    )
    .digest("hex");
  const domains = [...searchAllowedDomains];
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8135421)`;
    const previous = await findRun(tx, runId);
    if (previous) {
      if (previous.inputHash !== hash || previous.feedId !== query)
        throw new Error(
          "Run ID already belongs to a different input; use a new run ID",
        );
      return {
        runId: previous.id,
        parseError: previous.error,
        settled: previous.completedAt !== null,
      };
    }
    await createRun(tx, {
      id: runId,
      feedId: query,
      sourceKind: "search_query",
      sourceScope: { domains, provider, query },
      inputHash: hash,
      status: "running",
      error: null,
    });
    for (const [index, candidate] of candidates.entries()) {
      const { errors, publisher, ...metadata } = candidate;
      await createCandidate(tx, {
        runId,
        itemIndex: index,
        metadata: { ...metadata, publisher },
        errors,
      });
      // Relevance gate: the agent records its assessment and only accepted
      // candidates enter shared processing. Uncertain candidates stay
      // excluded (no publication, no discovery) until reviewed.
      if (!errors.length) {
        const assessment = assessRelevance(candidate.headline, query);
        await upsertReview(tx, {
          runId,
          itemIndex: index,
          decision: assessment.decision,
          reason: assessment.reason,
          decidedBy: "agent",
        });
        if (assessment.decision === "accepted") {
          await enqueueJob(tx, {
            source: searchSource(query, domains, provider),
            runId,
            itemIndex: index,
            operation: RESOLVE_PUBLICATION,
            payload: {
              itemIndex: index,
              publisher,
              searchQuery: query,
              provider,
              rank: candidate.rank,
            },
          });
        }
      }
    }
    return { runId, parseError: null, settled: false };
  });
}

// Operator relevance review: accept routes an excluded candidate into shared
// processing (idempotent when already resolved); reject keeps it excluded
// but inspectable via its candidate and decision rows. A rejection cannot
// retract an already resolved publication.
export async function reviewSearchCandidate(
  prisma: PrismaClient,
  runId: string,
  itemIndex: number,
  decision: "accepted" | "rejected",
  reason: string,
  fetchArticle: ArticleFetcher = fetchArticleHtml,
) {
  if (!reason.trim()) throw new Error("A review reason is required");
  const run = await findRunOrThrow(prisma, runId);
  if (run.sourceKind !== "search_query")
    throw new Error("Only search candidates can be relevance-reviewed");
  const candidate = await getCandidate(prisma, runId, itemIndex);
  if (!candidate) throw new Error("Candidate no longer exists");
  if ((candidate.errors as unknown[]).length)
    throw new Error("Invalid candidates stay excluded and cannot be reviewed");
  const metadata = candidate.metadata as {
    publisher: string;
    query: string;
    provider: SearchProvider;
    rank: number;
  };
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8135421)`;
    const current = await getCandidate(tx, runId, itemIndex);
    if (decision === "rejected") {
      if (current && !current.publicationId) {
        const job = await tx.processingJob.findUnique({
          where: {
            dedupeKey: dedupeKey(runId, itemIndex, RESOLVE_PUBLICATION),
          },
        });
        if (job && ["pending", "claimed", "retrying"].includes(job.status))
          throw new Error(
            "Cannot reject while publication resolution is pending",
          );
      }
    }
    await upsertReview(tx, {
      runId,
      itemIndex,
      decision,
      reason: reason.trim(),
      decidedBy: "operator",
    });
    if (decision === "accepted") {
      const job = await enqueueJob(tx, {
        source: searchSource(
          metadata.query,
          [...searchAllowedDomains],
          metadata.provider,
        ),
        runId,
        itemIndex,
        operation: RESOLVE_PUBLICATION,
        payload: {
          itemIndex,
          publisher: metadata.publisher,
          searchQuery: metadata.query,
          provider: metadata.provider,
          rank: metadata.rank,
        },
      });
      if (!current?.publicationId && job.status === "exhausted")
        await retryExhausted(tx, job.id);
    }
  });
  if (decision === "accepted") {
    await drainJobs(
      prisma,
      `review:${runId}:${itemIndex}`,
      { runId },
      fetchArticle,
    );
    await finalizeRunIfSettled(prisma, runId, run.error);
  }
  return getReview(prisma, runId, itemIndex);
}

// Live search collection with budget enforcement: an exhausted provider is
// paused with a visible reason while RSS and DIP collection continue
// independently. Never attaches payment or charges; it only spends the
// configured free-allowance call budget.
export async function collectSearchQuery(
  prisma: PrismaClient,
  runId: string,
  query: string,
  provider: SearchProvider,
  options: SearchCollectionOptions,
): Promise<SearchCollectionResult> {
  const now = options.now ?? new Date();
  const budget = providerBudget(provider, options.monthlyCallBudget);
  const previous = await findRun(prisma, runId);
  if (previous) {
    if (
      previous.sourceKind !== "search_query" ||
      previous.feedId !== query ||
      (previous.sourceScope as { provider?: string } | null)?.provider !==
        provider
    )
      throw new Error("Run ID already belongs to a different input");
    if (!previous.completedAt) {
      await drainJobs(
        prisma,
        `collect:${runId}`,
        { runId },
        options.fetchArticle,
      );
    }
    const run = previous.completedAt
      ? previous
      : await finalizeRunIfSettled(prisma, runId, previous.error);
    return {
      status: "completed",
      runId,
      valid: run.validCount,
      invalid: run.invalidCount,
      usage: { calls: 0 },
    };
  }
  if (!options.apiKey.trim()) throw new Error(`${provider} API key is missing`);
  const used = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(8135422, hashtext(${provider}))`;
    if (await tx.searchProviderCall.findUnique({ where: { runId } }))
      throw new Error(
        "Provider call already attempted for this run ID; use a new run ID",
      );
    const count = await countProviderCallsSince(
      tx,
      provider,
      monthStartUtc(now),
    );
    if (count >= budget) return count;
    await tx.searchProviderCall.create({
      data: { runId, provider, startedAt: now },
    });
    return null;
  });
  if (used !== null)
    return {
      status: "paused",
      runId,
      reason:
        `Monthly ${provider} call budget exhausted ` +
        `(${used}/${budget} calls); provider paused, RSS collection continues`,
    };
  const fetched = await fetchProviderResults(provider, query, {
    apiKey: options.apiKey,
    limit: options.limit,
    fetchFn: options.fetchFn,
  });
  const run = await collectSearch(
    prisma,
    runId,
    query,
    provider,
    fetched.results,
    options.fetchArticle ?? fetchArticleHtml,
  );
  return {
    status: "completed",
    runId,
    valid: run.validCount,
    invalid: run.invalidCount,
    usage: fetched.usage,
  };
}

export async function collectSearch(
  prisma: PrismaClient,
  runId: string,
  query: string,
  provider: SearchProvider,
  results: SearchResult[],
  fetchArticle: ArticleFetcher = fetchArticleHtml,
) {
  const intake = await collectSearchIntake(
    prisma,
    runId,
    query,
    provider,
    results,
  );
  if (intake.settled) return findRunOrThrow(prisma, runId);
  await drainJobs(prisma, `collect:${runId}`, { runId }, fetchArticle);
  return finalizeRunIfSettled(prisma, runId, intake.parseError);
}

// Commit boundary: one candidate's publication, identifiers, discovery
// encounter and candidate link commit together. Every write is an idempotent
// upsert keyed by identity or (run, publication), so a retried job never
// duplicates committed records.
export async function processJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  fetchArticle: ArticleFetcher = fetchArticleHtml,
): Promise<void> {
  if (job.operation === EXTRACT_TEXT) {
    await processExtractJob(prisma, job, fetchArticle);
    return;
  }
  if (job.operation !== RESOLVE_PUBLICATION || job.itemIndex === null)
    throw new Error(`Unknown job operation: ${job.operation}`);
  const payload = job.payload as { publisher?: unknown; feedId?: unknown };
  const rawPublisher = payload.publisher;
  if (typeof rawPublisher !== "string")
    throw new Error("Publication job is missing its publisher");
  const feedId = typeof payload.feedId === "string" ? payload.feedId : null;
  await prisma.$transaction(async (tx) => {
    const candidate = await getCandidate(tx, job.runId, job.itemIndex!);
    if (!candidate) throw new Error("Candidate for job no longer exists");
    if (job.sourceKind === "search_query") {
      const review = await getReview(tx, job.runId, job.itemIndex!);
      if (review?.decision !== "accepted")
        throw new Error("Search candidate is not accepted for publication");
    }
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
      ].filter((k): k is IdentityKey => k !== null);
      const matches = keys.length
        ? await findPublicationIdsByKeys(tx, publisher, keys)
        : [];
      const identities = new Set(matches.map((m) => m.publicationId));
      if (identities.size > 1)
        errors.push(
          "Conflicting publication identities; manual inspection required",
        );
      else {
        publicationId = [...identities][0] ?? randomUUID();
        await upsertPublication(
          tx,
          {
            id: publicationId,
            publisher,
            headline: metadata.headline,
            originalUrl: metadata.originalUrl,
            publishedAt: metadata.publishedAt,
            language,
          },
          {
            headline: metadata.headline,
            publishedAt: metadata.publishedAt,
            language,
            lastDiscoveredAt: new Date(),
          },
        );
        for (const { kind, value } of keys) {
          await upsertIdentifier(tx, { publisher, kind, value }, publicationId);
        }
        await upsertDiscovery(tx, job.runId, publicationId);
        await enqueueJob(tx, {
          source: feedSource(feedId ?? job.runId),
          runId: job.runId,
          itemIndex: job.itemIndex!,
          operation: EXTRACT_TEXT,
          payload: { publicationId, publisher },
        });
      }
    }
    await updateCandidateResult(tx, job.runId, job.itemIndex!, {
      errors,
      publicationId,
    });
  });
}

// One extract pass: fetch the directly linked article, store changed text as
// a new version, keep the original link on any failure. Permanent failures
// (permissions, blocked targets, unsupported formats, thin pages) record the
// fallback and succeed; transient fetch errors throw so the job backs off.
async function processExtractJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  fetchArticle: ArticleFetcher,
): Promise<void> {
  const payload = job.payload as {
    publicationId?: unknown;
    publisher?: unknown;
  };
  if (
    typeof payload.publicationId !== "string" ||
    typeof payload.publisher !== "string"
  )
    throw new Error("Extraction job is missing its publication");
  const { publicationId, publisher } = payload;
  const publication = await prisma.publication.findUnique({
    where: { id: publicationId },
  });
  if (!publication) throw new Error("Publication for job no longer exists");
  const fetched = await fetchArticle(publication.originalUrl);
  if (!fetched.ok) {
    if (isPermanentFailure(fetched.reason)) {
      await recordExtractionFailure(prisma, publicationId, fetched.reason);
      return;
    }
    throw new Error(fetched.reason);
  }
  const text = extractArticleText(fetched.html);
  if (!text) {
    await recordExtractionFailure(
      prisma,
      publicationId,
      "No article text found; kept original link",
    );
    return;
  }
  await prisma.$transaction(async (tx) => {
    await storeExtractedText(tx, {
      publicationId,
      publisher,
      finalUrl: fetched.finalUrl,
      text,
    });
  });
}

// A worker pass: claim ready jobs one at a time until none remain claimable
// now. One job's failure is recorded on that job and never stops the rest,
// so independent sources keep moving while a failing source backs off.
export async function drainJobs(
  prisma: PrismaClient,
  workerId: string,
  filter: { runId?: string; jobId?: string } = {},
  fetchArticle: ArticleFetcher = fetchArticleHtml,
) {
  const outcome = { succeeded: 0, retrying: 0, exhausted: 0 };
  for (;;) {
    const job = await claimNextJob(prisma, workerId, undefined, filter);
    if (!job) return outcome;
    try {
      await processJob(prisma, job, fetchArticle);
      await completeJob(prisma, job, workerId);
      outcome.succeeded++;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Job processing failed";
      const { exhausted } = await failJob(
        prisma,
        job,
        workerId,
        error instanceof Error ? error : new Error("Job processing failed"),
      );
      if (exhausted) {
        outcome.exhausted++;
        // An exhausted extraction still leaves a visible metadata-only
        // fallback: record the failure on the publication itself.
        if (job.operation === EXTRACT_TEXT) {
          const payload = job.payload as { publicationId?: unknown };
          if (typeof payload.publicationId === "string") {
            await recordExtractionFailure(
              prisma,
              payload.publicationId,
              message,
            ).catch(() => {});
          }
        }
      } else outcome.retrying++;
    }
  }
}

export async function finalizeRunIfSettled(
  prisma: PrismaClient,
  runId: string,
  parseError: string | null,
) {
  const open = await countOpenJobs(prisma, runId);
  if (open > 0) return findRunOrThrow(prisma, runId);
  const candidates = await listCandidatesForTally(prisma, runId);
  // Only successfully processed candidates count as valid: a job that
  // exhausted without processing leaves errors empty but no publication.
  const valid = candidates.filter(
    (c) => (c.errors as unknown[]).length === 0 && c.publicationId !== null,
  ).length;
  return finalizeRun(prisma, runId, {
    status: parseError ? "failed" : "completed",
    completedAt: new Date(),
    validCount: valid,
    invalidCount: candidates.length - valid,
    error: parseError,
  });
}

export async function collect(
  prisma: PrismaClient,
  runId: string,
  xml: string,
  feed: Feed = configuredFeed,
  fetchArticle: ArticleFetcher = fetchArticleHtml,
) {
  const intake = await collectIntake(prisma, runId, xml, feed);
  if (intake.settled) return findRunOrThrow(prisma, runId);
  await drainJobs(prisma, `collect:${runId}`, { runId }, fetchArticle);
  return finalizeRunIfSettled(prisma, runId, intake.parseError);
}

// Standalone worker pass without new intake: recover stale claims, drain
// ready jobs (optionally for one run), and settle finished runs. This is the
// entry point for out-of-band retries and the future scheduler.
export async function drainOpenJobs(
  prisma: PrismaClient,
  workerId: string,
  runId?: string,
  fetchArticle: ArticleFetcher = fetchArticleHtml,
) {
  await requeueStaleClaims(prisma);
  const outcome = await drainJobs(
    prisma,
    workerId,
    runId ? { runId } : {},
    fetchArticle,
  );
  const targets = runId
    ? [await findRunOrThrow(prisma, runId)]
    : await prisma.run.findMany({ where: { completedAt: null } });
  const settled: string[] = [];
  for (const target of targets) {
    const before = target.completedAt;
    const run = await finalizeRunIfSettled(prisma, target.id, target.error);
    if (!before && run.completedAt) settled.push(run.id);
  }
  return { outcome, settled };
}

export async function collectFixtureRun(prisma: PrismaClient, runId: string) {
  const xml = await readFile("fixtures/bundestag.xml", "utf8");
  return collect(prisma, runId, xml, fixtureFeed);
}

export async function collectAll(
  prisma: PrismaClient,
  runPrefix: string,
  fetchXml: (url: string) => Promise<string> = fetchFeedXml,
  feeds: Feed[] = publicNewsFeeds,
  fetchArticle: ArticleFetcher = fetchArticleHtml,
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
      const run = await collect(prisma, runId, xml, feed, fetchArticle);
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

export async function verifyFeed(
  feed: Feed = configuredFeed,
  fetchXml: (url: string) => Promise<string> = fetchFeedXml,
) {
  if (!feed.url) throw new Error("No feed URL");
  const xml = await fetchXml(feed.url);
  return summarizeFeed(feed, parseFeed(xml, feed.defaultLanguage));
}

export async function verifyAllFeeds(
  fetchXml: (url: string) => Promise<string> = fetchFeedXml,
  feeds: Feed[] = publicNewsFeeds,
) {
  const report = [];
  for (const feed of feeds) {
    if (!feed.url) {
      report.push({
        feed: feed.id,
        publisher: feed.publisher,
        url: feed.url,
        error: "Feed has no live URL",
      });
      continue;
    }
    try {
      const xml = await fetchXml(feed.url);
      report.push(summarizeFeed(feed, parseFeed(xml, feed.defaultLanguage), 2));
    } catch (error) {
      report.push({
        feed: feed.id,
        publisher: feed.publisher,
        url: feed.url,
        error: error instanceof Error ? error.message : "Verification failed",
      });
    }
  }
  return report;
}
