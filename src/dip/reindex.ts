import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client";
import { EMBED_DOCUMENT, EMBED_PROCEEDING, EMBED_STEP } from "./jobs";

// A model gets its own jobs, while source versions and extracted pages stay shared.
export async function enqueueDipReindex(
  prisma: PrismaClient,
  model: string,
  samplePercent = 100,
) {
  if (
    !Number.isInteger(samplePercent) ||
    samplePercent < 1 ||
    samplePercent > 100
  )
    throw new Error("Sample percent must be an integer from 1 to 100");
  const selected = (entity: string, id: string) =>
    createHash("sha256").update(`${entity}:${id}`).digest().readUInt32BE(0) /
      2 ** 32 <
    samplePercent / 100;
  const runId = `embedding-reindex:${model}`;
  await prisma.run.upsert({
    where: { id: runId },
    update: {},
    create: {
      id: runId,
      feedId: "/reindex",
      sourceKind: "dip_endpoint",
      inputHash: model,
      status: "completed",
      completedAt: new Date(),
    },
  });
  const counts = { proceedings: 0, steps: 0, pages: 0 };
  let cursor: string | undefined;
  do {
    const rows = await prisma.proceeding.findMany({
      select: { apiId: true, latestVersionNo: true },
      orderBy: { apiId: "asc" },
      take: 500,
      ...(cursor ? { cursor: { apiId: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    const result = await prisma.processingJob.createMany({
      data: rows
        .filter(
          (row) => row.latestVersionNo > 0 && selected("vorgang", row.apiId),
        )
        .map((row) => ({
          dedupeKey: JSON.stringify([
            "reindex",
            model,
            EMBED_PROCEEDING,
            row.apiId,
            row.latestVersionNo,
          ]),
          sourceKind: "dip_endpoint" as const,
          sourceKey: "/vorgang",
          runId,
          operation: EMBED_PROCEEDING,
          payload: { apiId: row.apiId, versionNo: row.latestVersionNo, model },
        })),
      skipDuplicates: true,
    });
    counts.proceedings += result.count;
    cursor = rows.at(-1)!.apiId;
    if (rows.length < 500) break;
  } while (true);
  cursor = undefined;
  do {
    const rows: { apiId: string; latestVersionNo: number }[] =
      await prisma.proceedingStep.findMany({
        select: { apiId: true, latestVersionNo: true },
        orderBy: { apiId: "asc" },
        take: 500,
        ...(cursor ? { cursor: { apiId: cursor }, skip: 1 } : {}),
      });
    if (!rows.length) break;
    const result = await prisma.processingJob.createMany({
      data: rows
        .filter(
          (row) =>
            row.latestVersionNo > 0 && selected("vorgangsposition", row.apiId),
        )
        .map((row) => ({
          dedupeKey: JSON.stringify([
            "reindex",
            model,
            EMBED_STEP,
            row.apiId,
            row.latestVersionNo,
          ]),
          sourceKind: "dip_endpoint" as const,
          sourceKey: "/vorgangsposition",
          runId,
          operation: EMBED_STEP,
          payload: { apiId: row.apiId, versionNo: row.latestVersionNo, model },
        })),
      skipDuplicates: true,
    });
    counts.steps += result.count;
    cursor = rows.at(-1)!.apiId;
    if (rows.length < 500) break;
  } while (true);
  cursor = undefined;
  do {
    const rows: { id: string; referenceId: string; variantNo: number }[] =
      await prisma.documentContent.findMany({
        where: { isLatest: true },
        select: { id: true, referenceId: true, variantNo: true },
        orderBy: { id: "asc" },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
    if (!rows.length) break;
    const contents = new Map(
      rows
        .filter((content) => selected("dokument", content.referenceId))
        .map((content) => [content.id, content]),
    );
    if (contents.size) {
      const pages = await prisma.documentPage.findMany({
        where: { contentId: { in: [...contents.keys()] }, text: { not: "" } },
        select: { contentId: true, pageNo: true },
      });
      const jobs = pages.map((page) => {
        const content = contents.get(page.contentId)!;
        return {
          dedupeKey: JSON.stringify([
            "reindex",
            model,
            EMBED_DOCUMENT,
            content.referenceId,
            content.variantNo,
            page.pageNo,
          ]),
          sourceKind: "dip_endpoint" as const,
          sourceKey: "/vorgangsposition",
          runId,
          operation: EMBED_DOCUMENT,
          payload: {
            referenceId: content.referenceId,
            variantNo: content.variantNo,
            pageNo: page.pageNo,
            model,
          },
        };
      });
      for (let i = 0; i < jobs.length; i += 500) {
        const result = await prisma.processingJob.createMany({
          data: jobs.slice(i, i + 500),
          skipDuplicates: true,
        });
        counts.pages += result.count;
      }
    }
    cursor = rows.at(-1)!.id;
    if (rows.length < 100) break;
  } while (true);
  return counts;
}
