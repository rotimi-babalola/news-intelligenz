import type { PrismaClient } from "../generated/prisma/client";
import { claimNextJob, completeJob, failJob } from "../jobs";
import { EMBED_PROCEEDING } from "./jobs";
import { findProceedingVersion, saveProceedingEmbedding } from "./repository";

export const EMBEDDING_MODEL = "qwen3-embedding:0.6b";
// Qwen3 embeds retrieval documents without a prefix; queries use this task.
export const DOCUMENT_INSTRUCTION = "";
export const QUERY_INSTRUCTION =
  "Given a German or English query, retrieve relevant German parliamentary proceedings and steps";

type Embed = (text: string) => Promise<number[]>;

export async function embedDocument(text: string): Promise<number[]> {
  const port = Number(process.env.OLLAMA_PORT || "11434");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("OLLAMA_PORT must be a valid TCP port");
  const response = await fetch(`http://127.0.0.1:${port}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      truncate: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`Ollama embedding failed: HTTP ${response.status}`);
  const body = (await response.json()) as {
    model?: string;
    embeddings?: number[][];
  };
  if (body.model !== EMBEDDING_MODEL)
    throw new Error("Ollama returned an unexpected embedding model");
  return body.embeddings?.[0] ?? [];
}

export async function processNextProceedingEmbedding(
  prisma: PrismaClient,
  workerId: string,
  options: { embed?: Embed; jobId?: string } = {},
) {
  const job = await claimNextJob(prisma, workerId, undefined, {
    operation: EMBED_PROCEEDING,
    jobId: options.jobId,
  });
  if (!job) return { status: "empty" as const };
  try {
    const payload = job.payload as { apiId?: unknown; versionNo?: unknown };
    const versionNo = payload.versionNo;
    if (
      typeof payload.apiId !== "string" ||
      typeof versionNo !== "number" ||
      !Number.isInteger(versionNo) ||
      versionNo < 1
    )
      throw new Error("Proceeding embedding job has an invalid source version");
    const version = await findProceedingVersion(
      prisma,
      payload.apiId,
      versionNo,
    );
    if (!version)
      throw new Error("Proceeding version for embedding no longer exists");
    const snapshot = version.snapshot as {
      title?: unknown;
      metadata?: { abstract?: unknown };
    };
    if (typeof snapshot.title !== "string" || !snapshot.title.trim())
      throw new Error("Proceeding version has no title");
    const summary = snapshot.metadata?.abstract;
    const text = [snapshot.title, typeof summary === "string" ? summary : ""]
      .filter(Boolean)
      .join("\n\n");
    const embedding = await (options.embed ?? embedDocument)(text);
    if (
      embedding.length !== 1024 ||
      !embedding.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    )
      throw new Error("Ollama returned an invalid 1024-dimensional embedding");
    await saveProceedingEmbedding(prisma, {
      apiId: payload.apiId,
      versionNo,
      model: EMBEDDING_MODEL,
      documentInstruction: DOCUMENT_INSTRUCTION,
      queryInstruction: QUERY_INSTRUCTION,
      embedding,
    });
    await completeJob(prisma, job, workerId);
    return { status: "succeeded" as const, jobId: job.id };
  } catch (error) {
    const { exhausted } = await failJob(
      prisma,
      job,
      workerId,
      error instanceof Error ? error : new Error("Proceeding embedding failed"),
    );
    return {
      status: exhausted ? ("exhausted" as const) : ("retrying" as const),
      jobId: job.id,
    };
  }
}
