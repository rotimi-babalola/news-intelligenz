import { randomUUID } from "node:crypto";
import type { Prisma, ProcessingJob } from "../generated/prisma/client";
import { fetchArticleHtml } from "../extract";
import {
  drainJobs,
  EXTRACT_TEXT,
  finalizeRunIfSettled,
  type ArticleFetcher,
} from "../import/service";
import { database } from "../db";
import {
  dedupeKey,
  jobCounts,
  listJobs,
  retryExhausted,
  type SourceKind,
} from "../jobs";
import { listCandidatesByRun } from "./candidate.repository";
import {
  listDipCandidates,
  listDipCheckpoints,
  listDipRuns,
  listParliamentaryDiscoveries,
} from "./dip.repository";
import { listDipGaps } from "../dip/repository";
import { listDiscoveriesByRun } from "./discovery.repository";
import {
  getPublicationDetail,
  listPublications,
} from "./publication.repository";
import { getRunOrThrow, listNewsRuns } from "./run.repository";

const NEWS_KINDS: SourceKind[] = ["news_feed", "search_query"];
const DIP_KINDS: SourceKind[] = ["dip_endpoint"];

// A crafted ?run= from the other area falls back to the first in-scope run
// instead of rendering out-of-scope rows through the wrong table.
function selectRun(runs: { id: string }[], runParam?: string): string {
  if (runParam !== undefined && runs.some((r) => r.id === runParam))
    return runParam;
  return runs[0]?.id ?? "";
}

function toAttention(
  pending: ProcessingJob[],
  retrying: ProcessingJob[],
  exhausted: ProcessingJob[],
) {
  return [...pending, ...retrying, ...exhausted]
    .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
    .slice(0, 100);
}

// Entry point: counts only, no run-scoped rows. Detailed inspection lives in
// /admin/news and /admin/dip, each scoped to its own source kinds.
export async function getAdminOverview() {
  const prisma = database();
  try {
    const [newsRuns, dipRuns, publications, newsCounts, dipCounts, gaps] =
      await Promise.all([
        prisma.run.count({ where: { sourceKind: { in: NEWS_KINDS } } }),
        prisma.run.count({ where: { sourceKind: { in: DIP_KINDS } } }),
        prisma.publication.count(),
        jobCounts(prisma, NEWS_KINDS),
        jobCounts(prisma, DIP_KINDS),
        listDipGaps(prisma, 50),
      ]);
    return { newsRuns, dipRuns, publications, newsCounts, dipCounts, gaps };
  } finally {
    await prisma.$disconnect();
  }
}

export async function getNewsOverview(runParam?: string) {
  const prisma = database();
  try {
    const [publications, runs] = await Promise.all([
      listPublications(prisma),
      listNewsRuns(prisma),
    ]);
    const selectedRun = selectRun(runs, runParam);
    const [candidates, discoveries, counts, pending, retrying, exhausted] =
      await Promise.all([
        listCandidatesByRun(prisma, selectedRun),
        listDiscoveriesByRun(prisma, selectedRun),
        jobCounts(prisma, NEWS_KINDS),
        listJobs(prisma, "pending", NEWS_KINDS),
        listJobs(prisma, "retrying", NEWS_KINDS),
        listJobs(prisma, "exhausted", NEWS_KINDS),
      ]);
    const attention = toAttention(pending, retrying, exhausted);
    return {
      publications,
      runs,
      selectedRun,
      candidates,
      discoveries,
      counts,
      attention,
    };
  } finally {
    await prisma.$disconnect();
  }
}

export async function getDipOverview(runParam?: string) {
  const prisma = database();
  try {
    const runs = await listDipRuns(prisma);
    const selectedRun = selectRun(runs, runParam);
    const [
      candidates,
      discoveries,
      checkpoints,
      gaps,
      counts,
      pending,
      retrying,
      exhausted,
    ] = await Promise.all([
      listDipCandidates(prisma, selectedRun),
      listParliamentaryDiscoveries(prisma, selectedRun),
      listDipCheckpoints(prisma),
      listDipGaps(prisma, 50),
      jobCounts(prisma, DIP_KINDS),
      listJobs(prisma, "pending", DIP_KINDS),
      listJobs(prisma, "retrying", DIP_KINDS),
      listJobs(prisma, "exhausted", DIP_KINDS),
    ]);
    const attention = toAttention(pending, retrying, exhausted);
    return {
      runs,
      selectedRun,
      candidates,
      discoveries,
      checkpoints,
      gaps,
      counts,
      attention,
    };
  } finally {
    await prisma.$disconnect();
  }
}

export async function getPublication(id: string) {
  const prisma = database();
  try {
    return await getPublicationDetail(prisma, id);
  } finally {
    await prisma.$disconnect();
  }
}

export async function retryJob(jobId: string) {
  const prisma = database();
  try {
    if (!jobId) throw new Error("Missing job id");
    const retried = await retryExhausted(prisma, jobId);
    await drainJobs(prisma, "admin-retry", { runId: retried.runId });
    const run = await getRunOrThrow(prisma, retried.runId);
    await finalizeRunIfSettled(prisma, retried.runId, run.error);
  } catch (error) {
    console.error(
      "Job retry failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Operator-driven re-extract: add a fresh job to its latest discovery run so
// earlier job attempts remain available, then drain only that job.
export async function reextractPublication(
  publicationId: string,
  fetchArticle: ArticleFetcher = fetchArticleHtml,
) {
  const prisma = database();
  try {
    if (!publicationId) throw new Error("Missing publication id");
    const publication = await prisma.publication.findUnique({
      where: { id: publicationId },
    });
    if (!publication) throw new Error("Publication not found");
    const discovery = await prisma.discovery.findFirst({
      where: { publicationId },
      orderBy: [{ discoveredAt: "desc" }],
    });
    if (!discovery) throw new Error("Publication has no discovery run");
    const run = await getRunOrThrow(prisma, discovery.runId);
    const candidate = await prisma.candidate.findFirst({
      where: { runId: run.id, publicationId },
    });
    const jobId = randomUUID();
    await prisma.processingJob.create({
      data: {
        id: jobId,
        dedupeKey: `${dedupeKey(run.id, candidate?.itemIndex ?? null, EXTRACT_TEXT)}:manual:${jobId}`,
        sourceKind: run.sourceKind,
        sourceKey: run.feedId,
        sourceScope: (run.sourceScope ?? undefined) as
          Prisma.InputJsonValue | undefined,
        runId: run.id,
        itemIndex: candidate?.itemIndex ?? null,
        operation: EXTRACT_TEXT,
        payload: { publicationId, publisher: publication.publisher },
      },
    });
    await drainJobs(prisma, "admin-reextract", { jobId }, fetchArticle);
    await finalizeRunIfSettled(prisma, run.id, run.error);
  } catch (error) {
    console.error(
      "Publication re-extract failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
  } finally {
    await prisma.$disconnect();
  }
}
