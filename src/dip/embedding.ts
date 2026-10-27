import type { PrismaClient } from "../generated/prisma/client";
import {
  claimNextJob,
  completeJob,
  failJob,
  parseRetryAfterMs,
  RateLimitedError,
} from "../jobs";
import { EMBED_DOCUMENT, EMBED_PROCEEDING, EMBED_STEP } from "./jobs";
import {
  findDocumentContent,
  findProceedingVersion,
  findStepVersion,
  saveDipEmbedding,
} from "./repository";
import { ensureDocumentChunks } from "./chunks";
import { enqueueDocumentEmbedding } from "./jobs";

export const EMBEDDING_MODEL = "qwen3-embedding:0.6b";
// Qwen3 embeds retrieval documents without a prefix.
export const DOCUMENT_INSTRUCTION = "";
export const QUERY_INSTRUCTION =
  "Given a German or English query, retrieve relevant German parliamentary proceedings and steps";

export function embeddingConfig() {
  const baseUrl = process.env.EMBEDDING_BASE_URL?.trim();
  const format =
    process.env.EMBEDDING_API_FORMAT || (baseUrl ? "openai" : "ollama");
  if (format !== "openai" && format !== "ollama" && format !== "voyage")
    throw new Error("EMBEDDING_API_FORMAT must be openai, ollama, or voyage");
  const port = Number(process.env.OLLAMA_PORT || "11434");
  const model = process.env.EMBEDDING_MODEL?.trim() || EMBEDDING_MODEL;
  return {
    model,
    indexId: process.env.EMBEDDING_INDEX_ID?.trim() || model,
    baseUrl: baseUrl || `http://127.0.0.1:${port}`,
    apiKey: process.env.EMBEDDING_API_KEY?.trim(),
    format,
    documentInstruction:
      process.env.EMBEDDING_DOCUMENT_INSTRUCTION ?? DOCUMENT_INSTRUCTION,
    queryInstruction:
      process.env.EMBEDDING_QUERY_INSTRUCTION ??
      (format === "ollama" ? QUERY_INSTRUCTION : ""),
  };
}

export function embeddingInput(
  text: string,
  kind: "query" | "document",
  config = embeddingConfig(),
) {
  const instruction =
    kind === "query" ? config.queryInstruction : config.documentInstruction;
  if (!instruction) return text;
  return kind === "query"
    ? `Instruct: ${instruction}\nQuery:${text}`
    : `Instruct: ${instruction}\nDocument:${text}`;
}

type Embed = (text: string) => Promise<number[]>;
let billedTokens = 0;
let unmeteredRequests = 0;

export function embeddingCost() {
  const price = Number(process.env.EMBEDDING_PRICE_PER_MILLION_TOKENS);
  return {
    billedTokens,
    unmeteredRequests,
    estimatedCost:
      unmeteredRequests === 0 && Number.isFinite(price) && price > 0
        ? (billedTokens * price) / 1_000_000
        : null,
  };
}

export function assertEmbedding(embedding: number[]) {
  if (
    !Array.isArray(embedding) ||
    embedding.length !== 1024 ||
    !embedding.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ) ||
    !embedding.some((value) => value !== 0)
  )
    throw new Error("Provider returned an invalid 1024-dimensional embedding");
}

export async function embedText(
  text: string,
  kind: "query" | "document" = "document",
): Promise<number[]> {
  const config = embeddingConfig();
  const port = Number(process.env.OLLAMA_PORT || "11434");
  if (
    !process.env.EMBEDDING_BASE_URL &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  )
    throw new Error("OLLAMA_PORT must be a valid TCP port");
  const url = new URL(
    config.format === "ollama" ? "api/embed" : "embeddings",
    `${config.baseUrl.replace(/\/$/, "")}/`,
  );
  if (
    url.protocol !== "https:" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost"
  )
    throw new Error("Remote embedding endpoints must use HTTPS");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      input: embeddingInput(text, kind, config),
      ...(config.format === "ollama"
        ? { truncate: false }
        : config.format === "voyage"
          ? { input_type: kind, output_dimension: 1024, truncation: false }
          : { dimensions: 1024, encoding_format: "float" }),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const message = `Embedding provider failed: HTTP ${response.status}`;
    if (response.status === 429)
      throw new RateLimitedError(
        message,
        parseRetryAfterMs(response.headers.get("retry-after")) ?? 60_000,
      );
    throw new Error(message);
  }
  const body = (await response.json()) as {
    model?: string;
    embeddings?: number[][];
    data?: { embedding: number[] }[];
    usage?: { total_tokens?: number };
  };
  if (body.model && body.model !== config.model)
    throw new Error("Embedding provider returned an unexpected model");
  const embedding =
    config.format === "ollama"
      ? body.embeddings?.[0]
      : body.data?.[0]?.embedding;
  assertEmbedding(embedding ?? []);
  if (typeof body.usage?.total_tokens === "number")
    billedTokens += body.usage.total_tokens;
  else unmeteredRequests++;
  return embedding!;
}

export async function processNextDipEmbedding(
  prisma: PrismaClient,
  workerId: string,
  options: {
    embed?: Embed;
    jobId?: string;
    operation?:
      typeof EMBED_PROCEEDING | typeof EMBED_STEP | typeof EMBED_DOCUMENT;
    reindexOnly?: boolean;
  } = {},
) {
  const config = embeddingConfig();
  const job = await claimNextJob(prisma, workerId, undefined, {
    operation: options.operation ?? [
      EMBED_PROCEEDING,
      EMBED_STEP,
      EMBED_DOCUMENT,
    ],
    jobId: options.jobId,
    payloadModel: config.indexId,
    includeModelLess: !options.reindexOnly,
  });
  if (!job) return { status: "empty" as const };
  try {
    const sourceOperation = job.operation;
    if (sourceOperation === EMBED_DOCUMENT) {
      const payload = job.payload as {
        referenceId?: unknown;
        variantNo?: unknown;
        pageNo?: unknown;
        chunkNo?: unknown;
        model?: unknown;
      };
      if (
        typeof payload.referenceId !== "string" ||
        typeof payload.variantNo !== "number" ||
        !Number.isInteger(payload.variantNo) ||
        payload.variantNo < 1 ||
        typeof payload.pageNo !== "number" ||
        !Number.isInteger(payload.pageNo) ||
        payload.pageNo < 1
      )
        throw new Error("Document embedding job has an invalid variant page");
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
        for (const chunk of chunks.filter(
          (item) => item.pageNo === page.pageNo,
        ))
          await enqueueDocumentEmbedding(prisma, {
            runId: job.runId,
            itemIndex: job.itemIndex,
            electoralTerm: null,
            referenceId: payload.referenceId,
            variantNo: payload.variantNo,
            pageNo: page.pageNo,
            chunkNo: chunk.chunkNo,
            model:
              typeof payload.model === "string" ? payload.model : undefined,
            priority: job.priority,
          });
      } else {
        if (
          typeof payload.chunkNo !== "number" ||
          !Number.isInteger(payload.chunkNo) ||
          payload.chunkNo < 1
        )
          throw new Error("Document embedding job has an invalid chunk");
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
      await completeJob(prisma, job, workerId);
      return { status: "succeeded" as const, jobId: job.id };
    }
    if (sourceOperation !== EMBED_PROCEEDING && sourceOperation !== EMBED_STEP)
      throw new Error("Unexpected DIP embedding operation");
    const payload = job.payload as { apiId?: unknown; versionNo?: unknown };
    const versionNo = payload.versionNo;
    if (
      typeof payload.apiId !== "string" ||
      typeof versionNo !== "number" ||
      !Number.isInteger(versionNo) ||
      versionNo < 1
    )
      throw new Error("DIP embedding job has an invalid source version");
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
    await completeJob(prisma, job, workerId);
    return { status: "succeeded" as const, jobId: job.id };
  } catch (error) {
    const { exhausted } = await failJob(
      prisma,
      job,
      workerId,
      error instanceof Error ? error : new Error("DIP embedding failed"),
    );
    return {
      status: exhausted ? ("exhausted" as const) : ("retrying" as const),
      jobId: job.id,
    };
  }
}
