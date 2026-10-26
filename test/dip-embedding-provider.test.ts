import assert from "node:assert/strict";
import { test } from "node:test";
import { embedText, embeddingConfig } from "../src/dip/embedding.js";
import { RateLimitedError } from "../src/jobs.js";

test("OpenAI-compatible provider uses configured model and 1024 dimensions", async () => {
  const previous = { ...process.env };
  const fetchBefore = globalThis.fetch;
  try {
    process.env.EMBEDDING_BASE_URL = "https://example.com/v1";
    process.env.EMBEDDING_MODEL = "candidate-a";
    process.env.EMBEDDING_API_KEY = "test-key";
    process.env.EMBEDDING_API_FORMAT = "openai";
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://example.com/v1/embeddings");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer test-key",
      );
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "candidate-a",
        input: "Hallo Bundestag",
        dimensions: 1024,
        encoding_format: "float",
      });
      return Response.json({
        model: "candidate-a",
        data: [{ embedding: Array(1024).fill(0.1) }],
        usage: { total_tokens: 3 },
      });
    };
    assert.equal(embeddingConfig().indexId, "candidate-a");
    assert.equal((await embedText("Hallo Bundestag")).length, 1024);
    globalThis.fetch = async () =>
      new Response("", { status: 429, headers: { "Retry-After": "2" } });
    await assert.rejects(
      embedText("Hallo"),
      (error) =>
        error instanceof RateLimitedError && error.retryAfterMs === 2000,
    );
  } finally {
    globalThis.fetch = fetchBefore;
    process.env = previous;
  }
});

test("Voyage requests distinct query and document embeddings", async () => {
  const previous = { ...process.env };
  const fetchBefore = globalThis.fetch;
  try {
    process.env.EMBEDDING_BASE_URL = "https://example.com/v1";
    process.env.EMBEDDING_MODEL = "voyage-4";
    process.env.EMBEDDING_API_FORMAT = "voyage";
    const inputTypes: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        input_type: string;
        output_dimension: number;
      };
      inputTypes.push(body.input_type);
      assert.equal(body.output_dimension, 1024);
      return Response.json({ data: [{ embedding: Array(1024).fill(0.1) }] });
    };
    await embedText("query", "query");
    await embedText("document", "document");
    assert.deepEqual(inputTypes, ["query", "document"]);
  } finally {
    globalThis.fetch = fetchBefore;
    process.env = previous;
  }
});

test(
  "hosted embedding smoke test",
  { skip: process.env.HOSTED_EMBEDDING_QA !== "1" },
  async () => {
    assert.equal((await embedText("Bundestag und Parlament")).length, 1024);
  },
);
