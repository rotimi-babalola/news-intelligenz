import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../app/api/ask/route.js";

const request = (
  origin: string,
  body: unknown = {},
  contentType = "application/json",
) =>
  new Request("http://localhost:3000/api/ask", {
    method: "POST",
    headers: {
      host: "localhost:3000",
      origin,
      "content-type": contentType,
    },
    body: JSON.stringify(body),
  });

const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

test("ask rejects foreign origins and non-JSON requests before generation", async () => {
  const foreign = await POST(
    request("https://example.org", { question: "Housing costs?" }),
  );
  assert.equal(foreign.status, 403);
  assert.equal(await code(foreign), "forbidden");

  const wrongType = await POST(
    request("http://localhost:3000", { question: "Housing?" }, "text/plain"),
  );
  assert.equal(wrongType.status, 403);
  assert.equal(await code(wrongType), "forbidden");
});

test("ask rejects a question over 1,000 characters", async () => {
  const response = await POST(
    request("http://localhost:3000", { question: "a".repeat(1001) }),
  );
  assert.equal(response.status, 400);
  assert.equal(await code(response), "invalid_request");
});
