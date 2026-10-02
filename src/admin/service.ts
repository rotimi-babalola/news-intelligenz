import { drainJobs, finalizeRunIfSettled } from "../import/service";
import { database } from "../db";
import { jobCounts, listJobs, retryExhausted } from "../jobs";
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
    const [candidates, discoveries, counts, retrying, exhausted] =
      await Promise.all([
        listCandidatesByRun(prisma, selectedRun),
        listDiscoveriesByRun(prisma, selectedRun),
        jobCounts(prisma),
        listJobs(prisma, "retrying"),
        listJobs(prisma, "exhausted"),
      ]);
    const attention = [...retrying, ...exhausted]
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
