import { createHash } from "node:crypto";
import { parseRetryAfterMs, RateLimitedError } from "../../jobs/index";
import {
  DOCUMENT_INSTRUCTION,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_TIMEOUT_MS,
  QUERY_INSTRUCTION,
} from "../constants";

export function embeddingConfig() {
  const format = process.env.EMBEDDING_API_FORMAT?.trim() || "openai";
  if (format !== "openai" && format !== "ollama" && format !== "voyage")
    throw new Error("EMBEDDING_API_FORMAT must be openai, ollama, or voyage");
  if (format === "voyage" && !process.env.EMBEDDING_BASE_URL?.trim())
    throw new Error("EMBEDDING_BASE_URL is required for Voyage");
  const port = Number(process.env.OLLAMA_PORT || "11434");
  const model = process.env.EMBEDDING_MODEL?.trim() || EMBEDDING_MODEL;
  const baseUrl = (
    process.env.EMBEDDING_BASE_URL?.trim() ||
    (format === "ollama"
      ? `http://127.0.0.1:${port}`
      : "https://api.openai.com/v1")
  ).replace(/\/$/, "");
  const documentInstruction =
    process.env.EMBEDDING_DOCUMENT_INSTRUCTION ?? DOCUMENT_INSTRUCTION;
  const queryInstruction =
    process.env.EMBEDDING_QUERY_INSTRUCTION ??
    (format === "ollama" ? QUERY_INSTRUCTION : "");
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        format,
        baseUrl,
        model,
        EMBEDDING_DIMENSIONS,
        documentInstruction,
        queryInstruction,
      ]),
    )
    .digest("hex")
    .slice(0, 12);
  return {
    model,
    indexId:
      process.env.EMBEDDING_INDEX_ID?.trim() ||
      `${format}:${model}:${identity}`,
    baseUrl,
    apiKey:
      process.env.EMBEDDING_API_KEY?.trim() ||
      (format === "openai" && baseUrl === "https://api.openai.com/v1"
        ? process.env.OPENAI_API_KEY?.trim()
        : undefined),
    format,
    documentInstruction,
    queryInstruction,
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
    embedding.length !== EMBEDDING_DIMENSIONS ||
    !embedding.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ) ||
    !embedding.some((value) => value !== 0)
  )
    throw new Error(
      `Provider returned an invalid ${EMBEDDING_DIMENSIONS}-dimensional embedding`,
    );
}

export async function embedText(
  text: string,
  kind: "query" | "document" = "document",
): Promise<number[]> {
  const config = embeddingConfig();
  if (config.baseUrl === "https://api.openai.com/v1" && !config.apiKey)
    throw new Error("OPENAI_API_KEY or EMBEDDING_API_KEY is required");
  const port = Number(process.env.OLLAMA_PORT || "11434");
  if (
    config.format === "ollama" &&
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
          ? {
              input_type: kind,
              output_dimension: EMBEDDING_DIMENSIONS,
              truncation: false,
            }
          : {
              dimensions: EMBEDDING_DIMENSIONS,
              encoding_format: "float",
            }),
    }),
    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
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
