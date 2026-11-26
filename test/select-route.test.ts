import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../app/api/select/route.js";

const request = (
  origin: string,
  body: unknown = {},
  contentType = "application/json",
) =>
  new Request("http://localhost:3000/api/select", {
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

test("select rejects foreign origins and non-JSON requests before searching", async () => {
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

test("select rejects a question over 1,000 characters", async () => {
  const response = await POST(
    request("http://localhost:3000", { question: "a".repeat(1001) }),
  );
  assert.equal(response.status, 400);
  assert.equal(await code(response), "invalid_request");
});

test("select returns a typed search failure when the database is unconfigured", async (t) => {
  const previousUrl = process.env.DATABASE_URL;
  t.after(() => {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });
  delete process.env.DATABASE_URL;

  const response = await POST(
    request("http://localhost:3000", { question: "Housing costs?" }),
  );
  assert.equal(response.status, 500);
  assert.equal(await code(response), "search_failed");
});
