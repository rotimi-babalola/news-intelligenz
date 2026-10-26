import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client";
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
  const batchSize = options.batchSize ?? 100;
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
