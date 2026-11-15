import type { PrismaClient } from "../../generated/prisma/client";
import { claimNextJob, completeJob, failJob } from "../../jobs";
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
import {
  EMBED_DOCUMENT,
  EMBED_PROCEEDING,
  EMBED_STEP,
  enqueueDocumentEmbeddings,
} from "./queue";

type Embed = (text: string) => Promise<number[]>;

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
        await enqueueDocumentEmbeddings(prisma, {
          runId: job.runId,
          itemIndex: job.itemIndex,
          electoralTerm: null,
          referenceId: payload.referenceId,
          variantNo: payload.variantNo,
          chunks: chunks.filter((item) => item.pageNo === page.pageNo),
          model: typeof payload.model === "string" ? payload.model : undefined,
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
      if (!(await completeJob(prisma, job, workerId)))
        return { status: "stale" as const, jobId: job.id };
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
    if (!(await completeJob(prisma, job, workerId)))
      return { status: "stale" as const, jobId: job.id };
    return { status: "succeeded" as const, jobId: job.id };
  } catch (error) {
    const { exhausted, stale } = await failJob(
      prisma,
      job,
      workerId,
      error instanceof Error ? error : new Error("DIP embedding failed"),
    );
    return {
      status: stale
        ? ("stale" as const)
        : exhausted
          ? ("exhausted" as const)
          : ("retrying" as const),
      jobId: job.id,
    };
  }
}
