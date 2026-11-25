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

for (const { name, url, message } of [
  {
    name: "missing",
    url: undefined,
    message: "DATABASE_URL is required",
  },
  {
    name: "malformed",
    url: "invalid",
    message: "DATABASE_URL must be a valid PostgreSQL URL",
  },
]) {
  test(`ask returns a typed error for ${name} database configuration`, async (t) => {
    const previousUrl = process.env.DATABASE_URL;
    t.after(() => {
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    });
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;

    const response = await POST(
      request("http://localhost:3000", { question: "Housing costs?" }),
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: { code: "generation_failed", message },
    });
  });
}
