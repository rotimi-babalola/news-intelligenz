import type { PrismaClient } from "../../generated/prisma/client";
import {
  runJobBatches,
  runJobs,
  runNextJob,
  type BatchStats,
  type ClaimedJob,
  type JobBatch,
  type JobOutcome,
} from "../../jobs/index";
import { ensureDocumentChunks } from "../documents/chunks";
import {
  findDocumentChunk,
  findDocumentChunks,
  findDocumentContent,
  findDocumentPage,
  findProceedingVersion,
  findStepVersion,
  saveDipEmbedding,
  saveDipEmbeddings,
} from "../db/index";
import {
  assertEmbedding,
  embedText,
  embedTexts,
  embeddingConfig,
  embeddingCost,
} from "../search/embedding";
import {
  EMBED_DOCUMENT,
  EMBED_DOCUMENT_BATCH_SIZE,
  EMBED_PROCEEDING,
  EMBED_STEP,
} from "../constants";
import { enqueueDocumentEmbeddings } from "./queue";
import { documentEmbeddingPayload, recordEmbeddingPayload } from "./identity";

type Embed = (text: string) => Promise<number[]>;
type EmbedBatch = (texts: string[]) => Promise<number[][]>;
type DocumentPayload = ReturnType<typeof documentEmbeddingPayload.parse>;

export type EmbeddingWorkerOptions = {
  embed?: Embed;
  embedBatch?: EmbedBatch;
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

// The drain's pass: one document batch first, so an on-demand passage (claimed
// first by priority) never waits behind the record pass; records next, so newly
// collected records never wait behind the document backlog; then the rest of
// the document backlog in batches. A retry ends the pass, because a provider
// outage or rate limit must not consume the queue's retry budget.
export async function drainDipEmbeddings(
  prisma: PrismaClient,
  workerId: string,
  options: EmbeddingWorkerOptions & { limit: number },
) {
  const config = embeddingConfig();
  const stopWhen = (outcome: JobOutcome) => outcome.status === "retrying";
  const documentOnly = options.operation === EMBED_DOCUMENT;
  const batched = options.operation === undefined || documentOnly;
  const recordOperation =
    options.operation === undefined
      ? [EMBED_PROCEEDING, EMBED_STEP]
      : options.operation;
  let billedTokens = 0;
  const documentHandler = async (jobs: ClaimedJob[]) => {
    const before = embeddingCost().billedTokens;
    const batch = await embedDocumentBatch(prisma, jobs, options, config);
    billedTokens = embeddingCost().billedTokens - before;
    return batch;
  };
  const documentOptions = (limit: number) => ({
    limit,
    stopWhen,
    failureMessage: "DIP embedding failed",
    onBatch: (stats: BatchStats) => console.log({ ...stats, billedTokens }),
  });
  const outcomes: JobOutcome[] = [];
  const drainDocuments = async (limit: number) => {
    if (!batched || limit <= 0) return;
    outcomes.push(
      ...(await runJobBatches(
        prisma,
        workerId,
        embeddingFilter(options, config, [EMBED_DOCUMENT]),
        EMBED_DOCUMENT_BATCH_SIZE,
        documentHandler,
        documentOptions(limit),
      )),
    );
  };
  await drainDocuments(Math.min(EMBED_DOCUMENT_BATCH_SIZE, options.limit));
  if (outcomes.some(stopWhen)) return outcomes;
  if (!documentOnly)
    outcomes.push(
      ...(await runJobs(
        prisma,
        workerId,
        embeddingFilter(options, config, recordOperation),
        (job) => embedJob(prisma, job, options, config),
        {
          limit: options.limit - outcomes.length,
          stopWhen,
          failureMessage: "DIP embedding failed",
        },
      )),
    );
  if (outcomes.some(stopWhen)) return outcomes;
  await drainDocuments(options.limit - outcomes.length);
  return outcomes;
}

function embeddingFilter(
  options: EmbeddingWorkerOptions,
  config: ReturnType<typeof embeddingConfig>,
  operation: string | string[] | undefined = options.operation,
) {
  return {
    operation: operation ?? [EMBED_PROCEEDING, EMBED_STEP, EMBED_DOCUMENT],
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
  if (job.operation === EMBED_DOCUMENT)
    return embedDocumentJob(prisma, job, options, config);
  const sourceOperation = job.operation;
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

async function embedDocumentJob(
  prisma: PrismaClient,
  job: ClaimedJob,
  options: EmbeddingWorkerOptions,
  config: ReturnType<typeof embeddingConfig>,
) {
  const payload = documentEmbeddingPayload.parse(job.payload);
  if (payload.chunkNo === undefined)
    return handOffDocumentPage(prisma, job, payload);
  const content = await findDocumentContent(
    prisma,
    payload.referenceId,
    payload.variantNo,
  );
  if (!content)
    throw new Error("Document variant for embedding no longer exists");
  const chunk = await findDocumentChunk(
    prisma,
    content.id,
    payload.pageNo,
    payload.chunkNo,
  );
  if (!chunk) throw new Error("Document chunk for embedding no longer exists");
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

// Page jobs queued before chunking hand off to passage jobs.
async function handOffDocumentPage(
  prisma: PrismaClient,
  job: ClaimedJob,
  payload: DocumentPayload,
) {
  const content = await findDocumentContent(
    prisma,
    payload.referenceId,
    payload.variantNo,
  );
  if (!content)
    throw new Error("Document variant for embedding no longer exists");
  const page = await findDocumentPage(prisma, content.id, payload.pageNo);
  if (!page) throw new Error("Document page for embedding no longer exists");
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
}

// One provider request and one vector write for the whole batch. Jobs that
// cannot resolve are failed alone so one stale passage does not take the batch
// with it; a provider or write failure fails every passage in the batch.
async function embedDocumentBatch(
  prisma: PrismaClient,
  jobs: ClaimedJob[],
  options: EmbeddingWorkerOptions,
  config: ReturnType<typeof embeddingConfig>,
): Promise<JobBatch> {
  const succeeded: ClaimedJob[] = [];
  const failed: { job: ClaimedJob; error: Error }[] = [];
  const pageJobs: { job: ClaimedJob; payload: DocumentPayload }[] = [];
  const passageJobs: { job: ClaimedJob; payload: DocumentPayload }[] = [];
  for (const job of jobs) {
    try {
      const payload = documentEmbeddingPayload.parse(job.payload);
      (payload.chunkNo === undefined ? pageJobs : passageJobs).push({
        job,
        payload,
      });
    } catch (error) {
      failed.push({ job, error: asError(error) });
    }
  }
  for (const { job, payload } of pageJobs) {
    try {
      await handOffDocumentPage(prisma, job, payload);
      succeeded.push(job);
    } catch (error) {
      failed.push({ job, error: asError(error) });
    }
  }
  const chunks = await findDocumentChunks(
    prisma,
    passageJobs.map(({ payload }) => ({
      referenceId: payload.referenceId,
      variantNo: payload.variantNo,
      pageNo: payload.pageNo,
      chunkNo: payload.chunkNo!,
    })),
  );
  const byKey = new Map(
    chunks.map((chunk) => [
      chunkKey(
        chunk.content.referenceId,
        chunk.content.variantNo,
        chunk.pageNo,
        chunk.chunkNo,
      ),
      chunk,
    ]),
  );
  const ready: { job: ClaimedJob; payload: DocumentPayload; text: string }[] =
    [];
  for (const { job, payload } of passageJobs) {
    const chunk = byKey.get(
      chunkKey(
        payload.referenceId,
        payload.variantNo,
        payload.pageNo,
        payload.chunkNo!,
      ),
    );
    if (!chunk)
      failed.push({
        job,
        error: new Error("Document chunk for embedding no longer exists"),
      });
    else ready.push({ job, payload, text: chunk.text });
  }
  if (!ready.length) return { succeeded, failed };
  try {
    const embedBatch =
      options.embedBatch ??
      (options.embed
        ? (texts: string[]) =>
            Promise.all(texts.map((text) => options.embed!(text)))
        : embedTexts);
    const embeddings = await embedBatch(ready.map((item) => item.text));
    assertEmbeddings(embeddings, ready.length);
    await saveDipEmbeddings(
      prisma,
      ready.map(({ payload }, index) => ({
        sourceEntity: "dokument" as const,
        apiId: payload.referenceId,
        versionNo: payload.variantNo,
        sourcePage: payload.pageNo,
        sourceChunk: payload.chunkNo!,
        model: config.indexId,
        documentInstruction: config.documentInstruction,
        queryInstruction: config.queryInstruction,
        embedding: embeddings[index]!,
      })),
    );
    succeeded.push(...ready.map((item) => item.job));
  } catch (error) {
    const failure = asError(error);
    for (const { job } of ready) failed.push({ job, error: failure });
  }
  return { succeeded, failed };
}

function assertEmbeddings(embeddings: number[][], expected: number) {
  if (!Array.isArray(embeddings) || embeddings.length !== expected)
    throw new Error(
      `Embedding provider returned ${embeddings?.length ?? 0} embeddings for ${expected} passages`,
    );
  embeddings.forEach(assertEmbedding);
}

function chunkKey(
  referenceId: string,
  variantNo: number,
  pageNo: number,
  chunkNo: number,
) {
  return `${referenceId}\u0000${variantNo}\u0000${pageNo}\u0000${chunkNo}`;
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error("DIP embedding failed");
}
