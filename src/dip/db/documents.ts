import type { Prisma } from "../../generated/prisma/client";
import { qualifiedTable } from "../../db";
import type { Client } from "./client";

export function findDocumentReference(client: Client, stepApiId: string) {
  return client.documentReference.findUnique({ where: { stepApiId } });
}

// Steps are discovered by collection runs; the latest encounter supplies the
// run a later on-demand document job belongs to.
export function latestStepDiscovery(client: Client, apiId: string) {
  return client.parliamentaryDiscovery.findFirst({
    where: { entity: "vorgangsposition", apiId },
    orderBy: { discoveredAt: "desc" },
  });
}

export async function latestStepDiscoveries(client: Client, apiIds: string[]) {
  const rows = await client.parliamentaryDiscovery.findMany({
    where: { entity: "vorgangsposition", apiId: { in: apiIds } },
    orderBy: { discoveredAt: "desc" },
    select: { apiId: true, runId: true },
  });
  const latest = new Map<string, string>();
  for (const row of rows)
    if (!latest.has(row.apiId)) latest.set(row.apiId, row.runId);
  return latest;
}

// A reference id may be cited by more than one step; on-demand requests only
// need one stored citation to resolve metadata for the document.
export function findDocumentReferenceById(client: Client, referenceId: string) {
  return client.documentReference.findFirst({
    where: { referenceId },
    orderBy: { observedAt: "desc" },
    include: { step: { select: { institution: true, documentType: true } } },
  });
}

export function findDocumentContentByHash(
  client: Client,
  referenceId: string,
  byteHash: string,
) {
  return client.documentContent.findUnique({
    where: { referenceId_byteHash: { referenceId, byteHash } },
  });
}

export function latestDocumentContent(client: Client, referenceId: string) {
  return client.documentContent.findFirst({
    where: { referenceId, isLatest: true },
    orderBy: { variantNo: "desc" },
  });
}

export function latestDocumentContents(client: Client, referenceIds: string[]) {
  return client.documentContent.findMany({
    where: { referenceId: { in: referenceIds }, isLatest: true },
    select: { referenceId: true, requestedUrl: true },
  });
}

export function documentJobsByKey(client: Client, dedupeKeys: string[]) {
  return client.processingJob.findMany({
    where: { dedupeKey: { in: dedupeKeys } },
    select: { dedupeKey: true },
  });
}

// One row per referenced document: the latest observation wins, so a changed
// URL or date is queued as its current revision rather than an older one.
export function listLatestDocumentReferences(
  client: Client,
  options: { afterReferenceId?: string; take: number },
) {
  return client.documentReference.findMany({
    where: {
      pdfUrl: { not: null },
      ...(options.afterReferenceId
        ? { referenceId: { gt: options.afterReferenceId } }
        : {}),
    },
    distinct: ["referenceId"],
    orderBy: [{ referenceId: "asc" }, { observedAt: "desc" }],
    take: options.take,
    select: {
      stepApiId: true,
      referenceId: true,
      documentNumber: true,
      pdfUrl: true,
      documentDate: true,
      metadata: true,
      step: { select: { institution: true, documentType: true } },
    },
  });
}

export async function countDocumentReferences(
  client: Client,
  options: { throughReferenceId?: string } = {},
) {
  const rows = await client.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(DISTINCT reference_id) AS count
     FROM ${qualifiedTable("document_references")}
     WHERE pdf_url IS NOT NULL
     ${options.throughReferenceId ? "AND reference_id <= $1" : ""}`,
    ...(options.throughReferenceId ? [options.throughReferenceId] : []),
  );
  return Number(rows[0]?.count ?? 0);
}

export function findDocumentChunk(
  client: Client,
  contentId: string,
  pageNo: number,
  chunkNo: number,
) {
  return client.documentChunk.findUnique({
    where: { contentId_pageNo_chunkNo: { contentId, pageNo, chunkNo } },
  });
}

// One query loads every passage a batch needs, so the database round trips do
// not grow with the batch size.
export function findDocumentChunks(
  client: Client,
  keys: {
    referenceId: string;
    variantNo: number;
    pageNo: number;
    chunkNo: number;
  }[],
) {
  if (!keys.length) return Promise.resolve([]);
  return client.documentChunk.findMany({
    where: {
      OR: keys.map((key) => ({
        content: {
          referenceId: key.referenceId,
          variantNo: key.variantNo,
        },
        pageNo: key.pageNo,
        chunkNo: key.chunkNo,
      })),
    },
    select: {
      pageNo: true,
      chunkNo: true,
      text: true,
      contentId: true,
      content: { select: { referenceId: true, variantNo: true } },
    },
  });
}

// Variant numbers only grow, even when an older variant is promoted back to
// latest: reused bytes must never reuse a number held by another variant.
export async function maxDocumentVariantNo(
  client: Client,
  referenceId: string,
) {
  const result = await client.documentContent.aggregate({
    where: { referenceId },
    _max: { variantNo: true },
  });
  return result._max.variantNo ?? 0;
}

export function findDocumentContent(
  client: Client,
  referenceId: string,
  variantNo: number,
) {
  return client.documentContent.findUnique({
    where: { referenceId_variantNo: { referenceId, variantNo } },
  });
}

export function createDocumentContent(
  client: Client,
  data: Prisma.DocumentContentUncheckedCreateInput,
) {
  return client.documentContent.create({ data });
}

export function createDocumentPages(
  client: Client,
  data: Prisma.DocumentPageUncheckedCreateInput[],
) {
  return client.documentPage.createMany({ data });
}

export function listDocumentPages(client: Client, contentId: string) {
  return client.documentPage.findMany({
    where: { contentId },
    orderBy: { pageNo: "asc" },
  });
}

export function listBoundedDocumentPages(
  client: Client,
  contentId: string,
  startPage: number,
  limit: number,
) {
  return client.documentPage.findMany({
    where: { contentId, pageNo: { gte: startPage } },
    orderBy: { pageNo: "asc" },
    take: limit,
    select: { pageNo: true, text: true },
  });
}

export function findDocumentPage(
  client: Client,
  contentId: string,
  pageNo: number,
) {
  return client.documentPage.findUnique({
    where: { contentId_pageNo: { contentId, pageNo } },
  });
}

export function listDocumentSections(client: Client, contentId: string) {
  return client.documentSection.findMany({
    where: { contentId },
    orderBy: { sectionNo: "asc" },
  });
}

export function createDocumentSections(
  client: Client,
  data: Prisma.DocumentSectionUncheckedCreateInput[],
) {
  return client.documentSection.createMany({ data, skipDuplicates: true });
}

export function supersedeDocumentContents(client: Client, referenceId: string) {
  return client.documentContent.updateMany({
    where: { referenceId, isLatest: true },
    data: { isLatest: false },
  });
}

export function upsertDocumentReference(
  client: Client,
  data: Prisma.DocumentReferenceUncheckedCreateInput,
) {
  return client.documentReference.upsert({
    where: { stepApiId: data.stepApiId },
    create: data,
    update: {
      proceedingApiId: data.proceedingApiId,
      referenceId: data.referenceId,
      documentNumber: data.documentNumber,
      pdfUrl: data.pdfUrl,
      documentDate: data.documentDate,
      metadata: data.metadata,
      observedAt: new Date(),
    },
  });
}
