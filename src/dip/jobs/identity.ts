import { z } from "zod";
import { dipSource, type EnqueueSpec } from "../../jobs/index";
import {
  EMBED_DOCUMENT,
  EMBED_PROCEEDING,
  EMBED_STEP,
  PROCESS_DOCUMENT,
  STEPS_ENDPOINT,
  VORGANG_ENDPOINT,
} from "../constants";

// Job identity is the dedupe key, source metadata and payload together. A
// producer builds all three through these functions, and the workers parse the
// payload with the same schema, so a key can never describe different work.
//
// These key arrays are frozen for operations that may already have queued
// jobs: preserve each shape and its model check exactly.
type Identity = EnqueueSpec & { dedupeKey: string };

export const recordEmbeddingPayload = z.object({
  apiId: z.string(),
  versionNo: z.number().int().min(1),
  model: z.string().optional(),
});

export const documentProcessingPayload = z.object({
  stepApiId: z.string(),
  referenceId: z.string(),
  pdfUrl: z.string().nullable(),
  electoralTerm: z.number().int().optional(),
});

export const documentEmbeddingPayload = z.object({
  referenceId: z.string(),
  variantNo: z.number().int().min(1),
  pageNo: z.number().int().min(1),
  chunkNo: z.number().int().min(1).optional(),
  model: z.string().optional(),
});

type RecordEmbeddingInput = {
  runId: string;
  itemIndex: number | null;
  electoralTerm: number | null;
  apiId: string;
  versionNo: number;
  model?: string;
};

function recordEmbeddingIdentity(
  input: RecordEmbeddingInput,
  operation: typeof EMBED_PROCEEDING | typeof EMBED_STEP,
): Identity {
  return {
    source: dipSource(
      operation === EMBED_PROCEEDING ? VORGANG_ENDPOINT : STEPS_ENDPOINT,
      input.electoralTerm === null ? undefined : String(input.electoralTerm),
    ),
    runId: input.runId,
    itemIndex: input.itemIndex,
    dedupeKey:
      input.model !== undefined
        ? JSON.stringify([
            "reindex",
            input.model,
            operation,
            input.apiId,
            input.versionNo,
          ])
        : JSON.stringify([
            input.runId,
            operation,
            input.apiId,
            input.versionNo,
          ]),
    operation,
    payload: recordEmbeddingPayload.parse({
      apiId: input.apiId,
      versionNo: input.versionNo,
      ...(input.model === undefined ? {} : { model: input.model }),
    }),
  };
}

export function proceedingEmbeddingIdentity(input: RecordEmbeddingInput) {
  return recordEmbeddingIdentity(input, EMBED_PROCEEDING);
}

export function stepEmbeddingIdentity(input: RecordEmbeddingInput) {
  return recordEmbeddingIdentity(input, EMBED_STEP);
}

// A changed reference (url or date) is a new revision and gets its own job;
// identical bytes are recognised from the cache at processing time.
export type DocumentJobKeyInput = {
  referenceId: string;
  pdfUrl: string | null;
  documentDate: Date | null;
};

export function documentJobKey(input: DocumentJobKeyInput) {
  return JSON.stringify([
    PROCESS_DOCUMENT,
    input.referenceId,
    input.pdfUrl,
    input.documentDate?.toISOString() ?? null,
  ]);
}

export function documentProcessingIdentity(input: {
  runId: string;
  itemIndex: number | null;
  electoralTerm: number | null;
  stepApiId: string;
  referenceId: string;
  pdfUrl: string | null;
  documentDate: Date | null;
}): Identity {
  return {
    source: dipSource(
      STEPS_ENDPOINT,
      input.electoralTerm === null ? undefined : String(input.electoralTerm),
    ),
    runId: input.runId,
    itemIndex: input.itemIndex,
    dedupeKey: documentJobKey(input),
    operation: PROCESS_DOCUMENT,
    payload: documentProcessingPayload.parse({
      stepApiId: input.stepApiId,
      referenceId: input.referenceId,
      pdfUrl: input.pdfUrl,
      ...(input.electoralTerm === null
        ? {}
        : { electoralTerm: input.electoralTerm }),
    }),
  };
}

// Each passage gets a durable job, so provider retries never repeat PDF work.
export function documentEmbeddingIdentity(input: {
  runId: string;
  itemIndex: number | null;
  electoralTerm: number | null;
  referenceId: string;
  variantNo: number;
  pageNo: number;
  chunkNo: number;
  model?: string;
}): Identity {
  return {
    source: dipSource(
      STEPS_ENDPOINT,
      input.electoralTerm === null ? undefined : String(input.electoralTerm),
    ),
    runId: input.runId,
    itemIndex: input.itemIndex,
    dedupeKey: JSON.stringify([
      ...(input.model ? ["reindex", input.model] : []),
      EMBED_DOCUMENT,
      input.referenceId,
      input.variantNo,
      input.pageNo,
      input.chunkNo,
    ]),
    operation: EMBED_DOCUMENT,
    payload: documentEmbeddingPayload.parse({
      referenceId: input.referenceId,
      variantNo: input.variantNo,
      pageNo: input.pageNo,
      chunkNo: input.chunkNo,
      ...(input.model ? { model: input.model } : {}),
    }),
  };
}
