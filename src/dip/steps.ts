import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { RateLimitedError, parseRetryAfterMs } from "../jobs";
import {
  createStep,
  createStepVersion,
  findDocumentReference,
  findProceeding,
  findStep,
  latestStepVersion,
  updateStep,
  upsertDipCandidate,
  upsertDocumentReference,
  upsertParliamentaryDiscovery,
} from "./repository";
import { enqueueDocumentProcessing, enqueueStepEmbedding } from "./jobs";
import { TerminalPageError, collectDipPages } from "./collect";
import type {
  CollectStepsOptions,
  CollectStepsResult,
  StoredDoc,
  StoredStep,
} from "./types";
import {
  isHotDocument,
  isUniqueViolation,
  stepContentHash,
  toStored,
  toStoredStep,
} from "./util";
import { storeProceedingPage, VORGANG_ENDPOINT } from "./vorgang";

export type {
  CollectStepsOptions,
  CollectStepsResult,
  FetchStepPage,
  FetchVorgang,
  StepPage,
} from "./types";

// DIP /vorgangsposition import. Steps link to proceedings through vorgang_id;
// a step whose parent is not stored is retained either way — unresolved
// parents stay inspectable on the step row, never silently discarded. An
// optional single-item parent fetch backfills genuinely missing context, but
// independently fetched endpoints are not an atomic snapshot and complete
// lifecycle coverage is never claimed from term filters alone.

export const STEPS_ENDPOINT = "/vorgangsposition";

async function storeStepsPage(
  tx: Prisma.TransactionClient,
  runId: string,
  steps: StoredStep[],
  parent: {
    followStored: boolean;
    cap: number | undefined;
    fetched: ReadonlyMap<string, StoredDoc>;
    electoralTerm: number;
    now: Date;
  },
) {
  let versionsAdded = 0;
  let capped = 0;
  let backfilled = 0;
  for (const { doc, raw, fundstelleRest, index } of steps) {
    const candidateMeta = { endpoint: STEPS_ENDPOINT, id: doc.id };
    let skipForCap = false;
    if (parent.followStored && !(await findProceeding(tx, doc.vorgang_id))) {
      const converted = parent.fetched.get(doc.vorgang_id);
      if (converted) {
        const outcome = await storeProceedingPage(
          tx,
          runId,
          [converted],
          parent.cap,
        );
        versionsAdded += outcome.versionsAdded;
        if (outcome.capped === 0) backfilled += 1;
        skipForCap = outcome.capped > 0;
      }
    }
    if (skipForCap) {
      capped += 1;
      await upsertDipCandidate(tx, runId, index, candidateMeta, []);
      continue;
    }
    const fundstelle = { ...doc.fundstelle, ...fundstelleRest };
    const hash = stepContentHash(doc, raw, fundstelleRest);
    const sourceUpdatedAt = new Date(doc.aktualisiert);
    const documentDate = new Date(doc.datum);
    const data = {
      proceedingApiId: doc.vorgang_id,
      institution: doc.zuordnung,
      stepLabel: doc.vorgangsposition,
      title: doc.titel,
      documentType: doc.dokumentart,
      documentDate,
      sourceUpdatedAt,
      metadata: raw as Prisma.InputJsonValue,
      lastObservedAt: new Date(),
    };
    const known = await findStep(tx, doc.id);
    const latest = await latestStepVersion(tx, doc.id);
    // Embed jobs submit only for versions this run creates; unchanged
    // observations add no work.
    let embeddedVersion: number | null = null;
    if (!known) {
      await createStep(tx, { apiId: doc.id, ...data, latestVersionNo: 1 });
      await createStepVersion(tx, {
        stepApiId: doc.id,
        versionNo: 1,
        contentHash: hash,
        snapshot: {
          ...data,
          metadata: raw,
          fundstelle,
        } as Prisma.InputJsonValue,
        sourceUpdatedAt,
        runId,
      });
      embeddedVersion = 1;
      versionsAdded += 1;
    } else if (latest && latest.contentHash === hash) {
      await updateStep(tx, doc.id, data);
    } else {
      const versionNo = (latest?.versionNo ?? 0) + 1;
      try {
        await createStepVersion(tx, {
          stepApiId: doc.id,
          versionNo,
          contentHash: hash,
          snapshot: {
            ...data,
            metadata: raw,
            fundstelle,
          } as Prisma.InputJsonValue,
          sourceUpdatedAt,
          runId,
        });
      } catch (error) {
        // A concurrent same-run writer stored this version first; reread and
        // reconcile instead of duplicating it.
        if (!isUniqueViolation(error)) throw error;
        const current = await latestStepVersion(tx, doc.id);
        if (!current || current.contentHash !== hash) throw error;
        await updateStep(tx, doc.id, data);
        continue;
      }
      await updateStep(tx, doc.id, { ...data, latestVersionNo: versionNo });
      embeddedVersion = versionNo;
      versionsAdded += 1;
    }
    if (embeddedVersion !== null) {
      await enqueueStepEmbedding(tx, {
        runId,
        itemIndex: index,
        electoralTerm: parent.electoralTerm,
        apiId: doc.id,
        versionNo: embeddedVersion,
      });
    }
    // Document references persist eagerly with the step; PDF bytes are never
    // fetched here. Only new or changed hot-subset references queue document
    // work; older references wait for an on-demand request (later slice).
    const previousRef = await findDocumentReference(tx, doc.id);
    const refDocumentDate = new Date(doc.fundstelle.datum);
    await upsertDocumentReference(tx, {
      stepApiId: doc.id,
      proceedingApiId: doc.vorgang_id,
      referenceId: doc.fundstelle.id,
      documentNumber: doc.fundstelle.dokumentnummer,
      pdfUrl: doc.fundstelle.pdf_url ?? null,
      documentDate: refDocumentDate,
      metadata: fundstelleRest as Prisma.InputJsonValue,
    });
    const refChanged =
      !previousRef ||
      previousRef.referenceId !== doc.fundstelle.id ||
      previousRef.documentNumber !== doc.fundstelle.dokumentnummer ||
      previousRef.pdfUrl !== (doc.fundstelle.pdf_url ?? null) ||
      previousRef.documentDate?.getTime() !== refDocumentDate.getTime();
    if (refChanged && isHotDocument(refDocumentDate, parent.now)) {
      await enqueueDocumentProcessing(tx, {
        runId,
        itemIndex: index,
        electoralTerm: parent.electoralTerm,
        stepApiId: doc.id,
        referenceId: doc.fundstelle.id,
        pdfUrl: doc.fundstelle.pdf_url ?? null,
        documentDate: refDocumentDate,
      });
    }
    await upsertDipCandidate(tx, runId, index, candidateMeta, []);
    await upsertParliamentaryDiscovery(tx, runId, "vorgangsposition", doc.id);
  }
  return { versionsAdded, capped, backfilled };
}

export async function collectSteps(
  prisma: PrismaClient,
  options: CollectStepsOptions,
): Promise<CollectStepsResult> {
  const now = options.now ?? new Date();
  return collectDipPages(
    prisma,
    STEPS_ENDPOINT,
    options,
    async (documents, firstIndex, runId) => {
      const kept: StoredStep[] = [];
      const invalidDocs: { index: number; error: string; id: string | null }[] =
        [];
      for (const [offset, input] of documents.entries()) {
        const converted = toStoredStep(input, firstIndex + offset);
        if ("error" in converted) {
          invalidDocs.push({
            index: converted.index,
            error: converted.error,
            id:
              typeof input === "object" && input !== null && "id" in input
                ? String((input as Record<string, unknown>)["id"])
                : null,
          });
        } else {
          kept.push(converted);
        }
      }
      const fetchedParents = new Map<string, StoredDoc>();
      if (options.followStoredParents && options.fetchVorgang) {
        const missing = new Map<string, number>();
        for (const { doc, index } of kept)
          if (!missing.has(doc.vorgang_id))
            missing.set(doc.vorgang_id, -index - 1);
        const existing = await prisma.proceeding.findMany({
          where: { apiId: { in: [...missing.keys()] } },
          select: { apiId: true },
        });
        for (const { apiId } of existing) missing.delete(apiId);
        for (const [apiId, index] of missing) {
          const fetched = await options.fetchVorgang(apiId);
          if (fetched === null) continue;
          const converted = toStored(fetched, index);
          if (!("error" in converted) && converted.doc.id === apiId)
            fetchedParents.set(apiId, converted);
        }
      }
      const counts = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(8135421)`;
        for (const { index, error, id } of invalidDocs) {
          await upsertDipCandidate(
            tx,
            runId,
            index,
            { endpoint: STEPS_ENDPOINT, id },
            [error],
          );
        }
        return storeStepsPage(tx, runId, kept, {
          followStored: options.followStoredParents ?? false,
          cap: options.proceedingCap,
          fetched: fetchedParents,
          electoralTerm: options.electoralTerm,
          now,
        });
      });
      let maxObserved: Date | null = null;
      for (const { doc } of kept) {
        const observed = new Date(doc.aktualisiert);
        if (!maxObserved || observed > maxObserved) maxObserved = observed;
      }
      return {
        valid: kept.length,
        invalid: invalidDocs.length,
        stored: kept.length - counts.capped,
        ...counts,
        maxObserved,
      };
    },
  );
}

// Live page fetcher for operational use (tests inject fakes). Single-item
// parent/step retrieval reuses the same auth and filter conventions.
export function liveStepsFetcher(apiKey: string): {
  fetchPage: CollectStepsOptions["fetchPage"];
  fetchVorgang: NonNullable<CollectStepsOptions["fetchVorgang"]>;
} {
  const headers = { Authorization: `ApiKey ${apiKey}` };
  return {
    fetchPage: async ({
      wahlperiode,
      aktualisiertStart,
      aktualisiertEnd,
      cursor,
    }) => {
      const query = new URLSearchParams({ format: "json" });
      query.set("f.wahlperiode", String(wahlperiode));
      if (aktualisiertStart)
        query.set("f.aktualisiert.start", aktualisiertStart);
      if (aktualisiertEnd) query.set("f.aktualisiert.end", aktualisiertEnd);
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(
        `https://search.dip.bundestag.de/api/v1/vorgangsposition?${query}`,
        { headers },
      );
      if (response.status === 429)
        throw new RateLimitedError(
          "DIP /vorgangsposition responded 429",
          parseRetryAfterMs(response.headers.get("retry-after")) ?? 60_000,
        );
      if (!response.ok) {
        const message = `DIP /vorgangsposition responded ${response.status}`;
        if (response.status >= 400 && response.status < 500)
          throw new TerminalPageError(message);
        throw new Error(message);
      }
      const body = (await response.json()) as {
        documents?: unknown[];
        cursor?: string;
        numFound?: number;
      };
      if (!Array.isArray(body.documents) || typeof body.cursor !== "string")
        throw new Error("DIP /vorgangsposition returned an unexpected payload");
      return {
        documents: body.documents,
        cursor: body.cursor,
        numFound: body.numFound ?? 0,
      };
    },
    fetchVorgang: async (id: string) => {
      const response = await fetch(
        `https://search.dip.bundestag.de/api/v1/vorgang/${id}?format=json`,
        { headers },
      );
      if (response.status === 404) return null;
      if (response.status === 429)
        throw new RateLimitedError(
          `DIP /vorgang/${id} responded 429`,
          parseRetryAfterMs(response.headers.get("retry-after")) ?? 60_000,
        );
      if (!response.ok) {
        const message = `DIP /vorgang/${id} responded ${response.status}`;
        if (response.status >= 400 && response.status < 500)
          throw new TerminalPageError(message);
        throw new Error(message);
      }
      return (await response.json()) as unknown;
    },
  };
}
