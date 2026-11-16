import { createHash } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import { ensureRun } from "../../run.repository";
import {
  EMBED_PROCEEDING,
  EMBED_STEP,
  REINDEX_DOCUMENT_PAGE_SIZE,
  REINDEX_PAGE_SIZE,
} from "../constants";
import { enqueueDocumentEmbeddings, enqueueRecordReindex } from "./queue";
import { ensureDocumentChunks } from "../documents/chunks";
import { ensureDocumentSections } from "../documents/sections";

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
  await ensureRun(prisma, {
    id: runId,
    // Legacy `feedId` column: holds the reindex source key, not a feed id.
    feedId: "/reindex",
    sourceKind: "dip_endpoint",
    inputHash: model,
    status: "completed",
    completedAt: new Date(),
  });
  const counts = { proceedings: 0, steps: 0, chunks: 0 };
  let cursor: string | undefined;
  do {
    const rows = await prisma.proceeding.findMany({
      select: { apiId: true, latestVersionNo: true },
      orderBy: { apiId: "asc" },
      take: REINDEX_PAGE_SIZE,
      ...(cursor ? { cursor: { apiId: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    const result = await enqueueRecordReindex(prisma, {
      runId,
      model,
      operation: EMBED_PROCEEDING,
      rows: rows.filter(
        (row) => row.latestVersionNo > 0 && selected("vorgang", row.apiId),
      ),
    });
    counts.proceedings += result.count;
    cursor = rows.at(-1)!.apiId;
    if (rows.length < REINDEX_PAGE_SIZE) break;
  } while (true);
  cursor = undefined;
  do {
    const rows: { apiId: string; latestVersionNo: number }[] =
      await prisma.proceedingStep.findMany({
        select: { apiId: true, latestVersionNo: true },
        orderBy: { apiId: "asc" },
        take: REINDEX_PAGE_SIZE,
        ...(cursor ? { cursor: { apiId: cursor }, skip: 1 } : {}),
      });
    if (!rows.length) break;
    const result = await enqueueRecordReindex(prisma, {
      runId,
      model,
      operation: EMBED_STEP,
      rows: rows.filter(
        (row) =>
          row.latestVersionNo > 0 && selected("vorgangsposition", row.apiId),
      ),
    });
    counts.steps += result.count;
    cursor = rows.at(-1)!.apiId;
    if (rows.length < REINDEX_PAGE_SIZE) break;
  } while (true);
  cursor = undefined;
  do {
    const rows: { id: string; referenceId: string; variantNo: number }[] =
      await prisma.documentContent.findMany({
        where: { isLatest: true },
        select: { id: true, referenceId: true, variantNo: true },
        orderBy: { id: "asc" },
        take: REINDEX_DOCUMENT_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
    if (!rows.length) break;
    for (const content of rows) {
      if (!selected("dokument", content.referenceId)) continue;
      const pages = await prisma.documentPage.findMany({
        where: { contentId: content.id },
        select: { pageNo: true, text: true },
      });
      const chunks = await ensureDocumentChunks(prisma, content.id, pages);
      await ensureDocumentSections(prisma, content.id, pages);
      counts.chunks += await enqueueDocumentEmbeddings(prisma, {
        runId,
        itemIndex: null,
        electoralTerm: null,
        referenceId: content.referenceId,
        variantNo: content.variantNo,
        chunks,
        model,
      });
    }
    cursor = rows.at(-1)!.id;
    if (rows.length < REINDEX_DOCUMENT_PAGE_SIZE) break;
  } while (true);
  return counts;
}
