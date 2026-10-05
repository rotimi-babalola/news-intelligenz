import { randomUUID } from "node:crypto";
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

// Operator-driven re-extract: ensure a pending extraction job for one
// publication (attached to its latest discovery run for the run FK) and
// drain it inline. Safe to repeat: identical text stores no new version.
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
    const key = dedupeKey(run.id, candidate?.itemIndex ?? null, EXTRACT_TEXT);
    const existing = await prisma.processingJob.findUnique({
      where: { dedupeKey: key },
    });
    // A live claim belongs to a running worker; don't steal it.
    if (!existing || existing.status !== "claimed") {
      const reset = {
        status: "pending" as const,
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        claimedAt: null,
        claimedBy: null,
        leaseExpiresAt: null,
        itemIndex: candidate?.itemIndex ?? null,
        payload: { publicationId, publisher: publication.publisher },
      };
      // A re-extract starts a new attempt lifecycle on the same job row, so
      // prior attempt records go with it; otherwise the next claim collides
      // with the old attempt numbers.
      await prisma.$transaction(async (tx) => {
        if (existing) {
          await tx.processingJob.update({
            where: { id: existing.id },
            data: reset,
          });
          await tx.jobAttempt.deleteMany({
            where: { jobId: existing.id },
          });
        } else {
          await tx.processingJob.create({
            data: {
              id: randomUUID(),
              dedupeKey: key,
              sourceKind: run.sourceKind,
              sourceKey: run.feedId,
              runId: run.id,
              ...reset,
              operation: EXTRACT_TEXT,
            },
          });
        }
      });
    }
    await drainJobs(prisma, "admin-reextract", { runId: run.id }, fetchArticle);
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
