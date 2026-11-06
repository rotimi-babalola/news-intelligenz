import type { Prisma } from "../generated/prisma/client";
import { enqueueProceedingEmbedding } from "./jobs";
import {
  createProceeding,
  createProceedingVersion,
  latestProceedingVersion,
  updateProceeding,
} from "./repository";
import type { StoredDoc } from "./types";
import { contentHash, isUniqueViolation } from "./util";

type Outcome = { created: boolean; versionAdded: boolean; duplicate: boolean };

async function captureVersion(
  known: boolean,
  latest: { versionNo: number; contentHash: string } | null,
  hash: string,
  work: {
    createRecord: () => Promise<unknown>;
    createVersion: (versionNo: number) => Promise<unknown>;
    latestVersion: () => Promise<{
      versionNo: number;
      contentHash: string;
    } | null>;
    updateRecord: (versionNo?: number) => Promise<unknown>;
    enqueueEmbedding: (versionNo: number) => Promise<unknown>;
  },
): Promise<Outcome> {
  if (!known) {
    await work.createRecord();
    await work.createVersion(1);
    await work.enqueueEmbedding(1);
    return { created: true, versionAdded: true, duplicate: false };
  }
  if (latest?.contentHash === hash) {
    await work.updateRecord();
    return { created: false, versionAdded: false, duplicate: false };
  }
  const versionNo = (latest?.versionNo ?? 0) + 1;
  try {
    await work.createVersion(versionNo);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const current = await work.latestVersion();
    if (!current || current.contentHash !== hash) throw error;
    await work.updateRecord();
    return { created: false, versionAdded: false, duplicate: true };
  }
  await work.updateRecord(versionNo);
  await work.enqueueEmbedding(versionNo);
  return { created: false, versionAdded: true, duplicate: false };
}

export async function captureProceedingVersion(
  tx: Prisma.TransactionClient,
  runId: string,
  { doc, raw, index }: StoredDoc,
  known: boolean,
): Promise<Outcome> {
  const hash = contentHash(doc, raw);
  const sourceUpdatedAt = new Date(doc.aktualisiert);
  const data = {
    title: doc.titel,
    proceedingType: doc.vorgangstyp,
    electoralTerm: doc.wahlperiode,
    deliberationState: doc.beratungsstand ?? null,
    documentDate: doc.datum ? new Date(doc.datum) : null,
    sourceUpdatedAt,
    metadata: raw as Prisma.InputJsonValue,
    lastObservedAt: new Date(),
  };
  const latest = await latestProceedingVersion(tx, doc.id);
  return captureVersion(known, latest, hash, {
    createRecord: () =>
      createProceeding(tx, { apiId: doc.id, ...data, latestVersionNo: 1 }),
    createVersion: (versionNo) =>
      createProceedingVersion(tx, {
        proceedingApiId: doc.id,
        versionNo,
        contentHash: hash,
        snapshot: { ...data, metadata: raw } as Prisma.InputJsonValue,
        sourceUpdatedAt,
        runId,
      }),
    latestVersion: () => latestProceedingVersion(tx, doc.id),
    updateRecord: (versionNo) =>
      updateProceeding(
        tx,
        doc.id,
        versionNo === undefined
          ? data
          : { ...data, latestVersionNo: versionNo },
      ),
    enqueueEmbedding: (versionNo) =>
      enqueueProceedingEmbedding(tx, {
        runId,
        itemIndex: index,
        electoralTerm: doc.wahlperiode,
        apiId: doc.id,
        versionNo,
      }),
  });
}
