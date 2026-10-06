import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/prisma/client";
import { fetchArticleHtml } from "../extract";
import {
  drainJobs,
  EXTRACT_TEXT,
  finalizeRunIfSettled,
  type ArticleFetcher,
} from "../import/service";
import { database } from "../db";
import { dedupeKey, jobCounts, listJobs, retryExhausted } from "../jobs";
import { listCandidatesByRun } from "./candidate.repository";
import { listDiscoveriesByRun } from "./discovery.repository";
import {
  getPublicationDetail,
  listPublications,
} from "./publication.repository";
import { getRunOrThrow, listRuns } from "./run.repository";

export async function getAdminOverview(runParam?: string) {
  const prisma = database();
  try {
    const [publications, runs] = await Promise.all([
      listPublications(prisma),
      listRuns(prisma),
    ]);
    const selectedRun = runParam ?? runs[0]?.id ?? "";
    const [candidates, discoveries, counts, pending, retrying, exhausted] =
      await Promise.all([
        listCandidatesByRun(prisma, selectedRun),
        listDiscoveriesByRun(prisma, selectedRun),
        jobCounts(prisma),
        listJobs(prisma, "pending"),
        listJobs(prisma, "retrying"),
        listJobs(prisma, "exhausted"),
      ]);
    const attention = [...pending, ...retrying, ...exhausted]
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, 100);
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
