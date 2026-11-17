import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../app/api/documents/[referenceId]/route.js";

function request(
  referenceId: string,
  origin = "http://localhost:3000",
  contentType: string | null = "application/json",
) {
  return new Request(`http://localhost:3000/api/documents/${referenceId}`, {
    method: "POST",
    headers: {
      host: "localhost:3000",
      origin,
      ...(contentType ? { "content-type": contentType } : {}),
    },
  });
}

function context(referenceId: string) {
  return { params: Promise.resolve({ referenceId }) };
}

test("queueing a document rejects requests that are not from this page", async () => {
  assert.equal(
    (await POST(request("123", "https://example.org"), context("123"))).status,
    403,
  );
  assert.equal(
    (await POST(request("123", "http://localhost:3000", null), context("123")))
      .status,
    403,
  );
});

test("queueing a document requires a numeric reference id", async () => {
  assert.equal((await POST(request("abc"), context("abc"))).status, 400);
});
