import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../app/api/test-brief/route.js";

const request = (origin: string) =>
  new Request("http://localhost:3000/api/test-brief", {
    method: "POST",
    headers: {
      host: "localhost:3000",
      origin,
      "content-type": "application/json",
    },
    body: "{}",
  });

test("brief tester rejects cross-origin requests before generation", async () => {
  assert.equal((await POST(request("https://example.org"))).status, 403);
  assert.equal((await POST(request("http://localhost:3000"))).status, 400);
});
