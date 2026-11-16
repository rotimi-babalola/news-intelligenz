import { createHash } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import { DOCUMENT_BACKFILL_BATCH_SIZE } from "../constants";
import {
  documentJobsByKey,
  latestDocumentContents,
  latestStepDiscoveries,
  listLatestDocumentReferences,
} from "../db/index";
import { documentJobKey } from "../jobs/identity";
import { enqueueDocumentProcessing } from "../jobs/queue";
import { classifyDocumentReference } from "./excerpts";
import { documentObjectKey, putDocumentPdf } from "./object-store";
import { fetchDocumentPdf } from "./pdf";

// Rows written before the object-storage move keep their bytes, or at least
// their source url. Archive them in place and record the key. The object key
// is content-addressed, so a url whose bytes changed no longer matches the
// stored hash and must not be uploaded under that key.
export type BackfillResult = {
  archived: number;
  skipped: number;
  failed: number;
};

export async function backfillDocumentObjects(
  prisma: PrismaClient,
  options: {
    batchSize?: number;
    dryRun?: boolean;
    putPdf?: typeof putDocumentPdf;
    fetchPdf?: typeof fetchDocumentPdf;
  } = {},
): Promise<BackfillResult> {
  const batchSize = options.batchSize ?? DOCUMENT_BACKFILL_BATCH_SIZE;
  const putPdf = options.putPdf ?? putDocumentPdf;
  const fetchPdf = options.fetchPdf ?? fetchDocumentPdf;
  const result: BackfillResult = { archived: 0, skipped: 0, failed: 0 };
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.documentContent.findMany({
      where: {
        OR: [{ objectKey: null }, { objectKey: "" }],
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.id;
    for (const row of rows) {
      try {
        const bytes = row.bytes
          ? Buffer.from(row.bytes)
          : row.sourceUrl
            ? await fetchBytes(fetchPdf, row.sourceUrl)
            : null;
        if (!bytes) {
          result.skipped += 1;
          console.warn(`${row.id}: no stored bytes and no source url; skipped`);
          continue;
        }
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (hash !== row.byteHash)
          throw new Error("source bytes no longer match the stored hash");
        const objectKey = documentObjectKey(row.referenceId, row.byteHash);
        if (!options.dryRun) {
          await putPdf(objectKey, bytes);
          await prisma.documentContent.update({
            where: { id: row.id },
            // Keep the column for contract compatibility but reclaim the row's
            // bytes now that the object is archived.
            data: { objectKey, bytes: null },
          });
        }
        result.archived += 1;
      } catch (error) {
        result.failed += 1;
        console.error(
          `${row.id}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    if (rows.length < batchSize) break;
  }
  return result;
}

async function fetchBytes(
  fetchPdf: typeof fetchDocumentPdf,
  url: string,
): Promise<Buffer> {
  const fetched = await fetchPdf(url);
  if (!fetched.ok) throw new Error(`source fetch failed: ${fetched.reason}`);
  return fetched.bytes;
}

export type QueueUnprocessedDocumentsResult = {
  queued: number;
  current: number;
  existing: number;
  skipped: number;
};

// Background processing queues only references dated in the previous 14 days.
// This pass queues every older eligible reference that has no current processed
// variant; the drain worker, not this script, still does the fetching.
export async function queueUnprocessedDocuments(
  prisma: PrismaClient,
  options: { batchSize?: number; dryRun?: boolean } = {},
): Promise<QueueUnprocessedDocumentsResult> {
  const batchSize = options.batchSize ?? DOCUMENT_BACKFILL_BATCH_SIZE;
  const result: QueueUnprocessedDocumentsResult = {
    queued: 0,
    current: 0,
    existing: 0,
    skipped: 0,
  };
  let cursor: string | undefined;
  for (;;) {
    const references = await listLatestDocumentReferences(prisma, {
      afterReferenceId: cursor,
      take: batchSize,
    });
    if (!references.length) break;
    cursor = references.at(-1)!.referenceId;
    const requestedUrls = new Map(
      (
        await latestDocumentContents(
          prisma,
          references.map(({ referenceId }) => referenceId),
        )
      ).map((content) => [content.referenceId, content.requestedUrl]),
    );
    const jobKeys = new Set(
      (
        await documentJobsByKey(
          prisma,
          references.map((reference) =>
            documentJobKey({
              referenceId: reference.referenceId,
              pdfUrl: reference.pdfUrl,
              documentDate: reference.documentDate,
            }),
          ),
        )
      ).map((job) => job.dedupeKey),
    );
    const runIds = await latestStepDiscoveries(
      prisma,
      references.map(({ stepApiId }) => stepApiId),
    );
    for (const reference of references) {
      if (
        requestedUrls.get(reference.referenceId) === reference.pdfUrl &&
        reference.pdfUrl !== null
      ) {
        result.current += 1;
        continue;
      }
      const identity = {
        referenceId: reference.referenceId,
        pdfUrl: reference.pdfUrl,
        documentDate: reference.documentDate,
      };
      if (jobKeys.has(documentJobKey(identity))) {
        result.existing += 1;
        continue;
      }
      if (
        classifyDocumentReference({
          institution: reference.step.institution,
          documentType: reference.step.documentType,
          documentNumber: reference.documentNumber,
          pdfUrl: reference.pdfUrl,
          metadata: reference.metadata,
        }).status !== "excerpt-eligible"
      ) {
        result.skipped += 1;
        continue;
      }
      const runId = runIds.get(reference.stepApiId);
      if (!runId) {
        result.skipped += 1;
        continue;
      }
      if (!options.dryRun)
        await enqueueDocumentProcessing(prisma, {
          runId,
          itemIndex: null,
          electoralTerm: null,
          stepApiId: reference.stepApiId,
          ...identity,
        });
      result.queued += 1;
    }
    if (references.length < batchSize) break;
  }
  return result;
}
