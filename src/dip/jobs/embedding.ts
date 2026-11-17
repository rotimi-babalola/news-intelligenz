import type { PrismaClient } from "../../generated/prisma/client";
import { runJobs, runNextJob, type ClaimedJob } from "../../jobs/index";
import { ensureDocumentChunks } from "../documents/chunks";
import {
  findDocumentContent,
  findProceedingVersion,
  findStepVersion,
  saveDipEmbedding,
} from "../db/index";
import {
  assertEmbedding,
  embedText,
  embeddingConfig,
} from "../search/embedding";
import { EMBED_DOCUMENT, EMBED_PROCEEDING, EMBED_STEP } from "../constants";
import { enqueueDocumentEmbeddings } from "./queue";
import { documentEmbeddingPayload, recordEmbeddingPayload } from "./identity";

type Embed = (text: string) => Promise<number[]>;

export type EmbeddingWorkerOptions = {
  embed?: Embed;
  jobId?: string;
  operation?:
    typeof EMBED_PROCEEDING | typeof EMBED_STEP | typeof EMBED_DOCUMENT;
  reindexOnly?: boolean;
};

export async function processNextDipEmbedding(
  prisma: PrismaClient,
  workerId: string,
  options: EmbeddingWorkerOptions = {},
) {
  const config = embeddingConfig();
  return runNextJob(
    prisma,
    workerId,
    embeddingFilter(options, config),
    (job) => embedJob(prisma, job, options, config),
    { failureMessage: "DIP embedding failed" },
  );
}

// The drain's pass: one recovery and one claim loop for the whole cap instead
// of one of each per job. A retry still ends the pass, because a provider
// outage or rate limit must not consume the queue's retry budget.
export async function drainDipEmbeddings(
  prisma: PrismaClient,
  workerId: string,
  options: EmbeddingWorkerOptions & { limit: number },
) {
  const config = embeddingConfig();
  return runJobs(
    prisma,
    workerId,
    embeddingFilter(options, config),
    (job) => embedJob(prisma, job, options, config),
    {
      limit: options.limit,
      stopWhen: (outcome) => outcome.status === "retrying",
      failureMessage: "DIP embedding failed",
    },
  );
}

function embeddingFilter(
  options: EmbeddingWorkerOptions,
  config: ReturnType<typeof embeddingConfig>,
) {
  return {
    operation: options.operation ?? [
      EMBED_PROCEEDING,
      EMBED_STEP,
      EMBED_DOCUMENT,
    ],
    jobId: options.jobId,
    payloadModel: config.indexId,
    includeModelLess: !options.reindexOnly,
  };
}

async function embedJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  options: EmbeddingWorkerOptions,
  config: ReturnType<typeof embeddingConfig>,
) {
  const sourceOperation = job.operation;
  if (sourceOperation === EMBED_DOCUMENT) {
    const payload = documentEmbeddingPayload.parse(job.payload);
    const content = await findDocumentContent(
      prisma,
      payload.referenceId,
      payload.variantNo,
    );
    if (!content)
      throw new Error("Document variant for embedding no longer exists");
    if (payload.chunkNo === undefined) {
      // Page jobs queued before chunking hand off to passage jobs.
      const page = await prisma.documentPage.findUnique({
        where: {
          contentId_pageNo: { contentId: content.id, pageNo: payload.pageNo },
        },
      });
      if (!page)
        throw new Error("Document page for embedding no longer exists");
      const chunks = await ensureDocumentChunks(prisma, content.id, [page]);
      await enqueueDocumentEmbeddings(prisma, {
        runId: job.runId,
        itemIndex: job.itemIndex,
        electoralTerm: null,
        referenceId: payload.referenceId,
        variantNo: payload.variantNo,
        chunks: chunks.filter((item) => item.pageNo === page.pageNo),
        model: payload.model,
        priority: job.priority,
      });
    } else {
      const chunk = await prisma.documentChunk.findUnique({
        where: {
          contentId_pageNo_chunkNo: {
            contentId: content.id,
            pageNo: payload.pageNo,
            chunkNo: payload.chunkNo,
          },
        },
      });
      if (!chunk)
        throw new Error("Document chunk for embedding no longer exists");
      const embedding = await (options.embed ?? embedText)(chunk.text);
      assertEmbedding(embedding);
      await saveDipEmbedding(prisma, {
        sourceEntity: "dokument",
        apiId: payload.referenceId,
        versionNo: payload.variantNo,
        sourcePage: chunk.pageNo,
        sourceChunk: chunk.chunkNo,
        model: config.indexId,
        documentInstruction: config.documentInstruction,
        queryInstruction: config.queryInstruction,
        embedding,
      });
    }
    return;
  }
  if (sourceOperation !== EMBED_PROCEEDING && sourceOperation !== EMBED_STEP)
    throw new Error("Unexpected DIP embedding operation");
  const payload = recordEmbeddingPayload.parse(job.payload);
  const versionNo = payload.versionNo;
  const version =
    sourceOperation === EMBED_PROCEEDING
      ? await findProceedingVersion(prisma, payload.apiId, versionNo)
      : await findStepVersion(prisma, payload.apiId, versionNo);
  if (!version) throw new Error("DIP version for embedding no longer exists");
  const snapshot = version.snapshot as {
    title?: unknown;
    stepLabel?: unknown;
    metadata?: { abstract?: unknown };
  };
  if (typeof snapshot.title !== "string" || !snapshot.title.trim())
    throw new Error("DIP version has no title");
  if (
    sourceOperation === EMBED_STEP &&
    (typeof snapshot.stepLabel !== "string" || !snapshot.stepLabel.trim())
  )
    throw new Error("Step version has no label");
  const summary = snapshot.metadata?.abstract;
  const text = [
    snapshot.title,
    sourceOperation === EMBED_STEP ? snapshot.stepLabel : "",
    typeof summary === "string" ? summary : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const embedding = await (options.embed ?? embedText)(text);
  assertEmbedding(embedding);
  await saveDipEmbedding(prisma, {
    sourceEntity:
      sourceOperation === EMBED_PROCEEDING ? "vorgang" : "vorgangsposition",
    apiId: payload.apiId,
    versionNo,
    model: config.indexId,
    documentInstruction: config.documentInstruction,
    queryInstruction: config.queryInstruction,
    embedding,
  });
}
