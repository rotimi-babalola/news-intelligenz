import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client";
import type { Candidate } from "../feed";
import type { SearchProvider } from "../search";
import type { Feed } from "../sources";
import { createRun, findRun } from "./run.repository";

export function providerApiKey(provider: SearchProvider): string {
  return (
    process.env[provider === "exa" ? "EXA_API_KEY" : "TAVILY_API_KEY"] ?? ""
  );
}

export function providerBudget(
  provider: SearchProvider,
  override?: number,
): number {
  if (override !== undefined) return override;
  const raw =
    process.env[
      provider === "exa"
        ? "SEARCH_EXA_MONTHLY_CALL_BUDGET"
        : "SEARCH_TAVILY_MONTHLY_CALL_BUDGET"
    ];
  const parsed = raw ? Number(raw) : NaN;
  // Default 186 covers six daily queries for a 31-day month.
  return Number.isFinite(parsed) && (parsed as number) >= 0
    ? Math.floor(parsed as number)
    : 186;
}

export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// Count reserved calls, including failed requests that may have spent allowance.
export async function countProviderCallsSince(
  prisma: PrismaClient | Prisma.TransactionClient,
  provider: SearchProvider,
  since: Date,
) {
  return prisma.searchProviderCall.count({
    where: {
      startedAt: { gte: since },
      provider,
    },
  });
}

export function summarizeFeed(feed: Feed, candidates: Candidate[], limit = 3) {
  const valid = candidates.filter((c) => !c.errors.length).length;
  return {
    feed: feed.id,
    publisher: feed.publisher,
    url: feed.url,
    entries: candidates.length,
    valid,
    invalid: candidates.length - valid,
    languages: [...new Set(candidates.map((c) => c.language))],
    firstHeadlines: candidates
      .slice(0, limit)
      .map((c) => ({ headline: c.headline, url: c.originalUrl })),
  };
}

export function isPermanentFailure(reason: string): boolean {
  return (
    reason.includes("not permitted") ||
    reason.includes("Blocked") ||
    reason.includes("Unsupported")
  );
}

export async function recordFeedFailure(
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
    const previous = await findRun(tx, runId);
    if (previous) return previous;
    return createRun(tx, {
      id: runId,
      feedId: feed.id,
      sourceKind: "news_feed",
      inputHash,
      status: "failed",
      completedAt: new Date(),
      validCount: 0,
      invalidCount: 0,
      error: message,
    });
  });
}
