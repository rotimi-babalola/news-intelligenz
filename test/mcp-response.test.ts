import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeMcpResponse } from "../src/mcp/response.js";

test("MCP errors never echo request values", async () => {
  const secret = "request-secret";
  for (const [body, contentType] of [
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: secret,
        error: { message: `Tool ${secret} not found` },
      }),
      "application/json",
    ],
    [
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: secret }] } })}\n\n`,
      "text/event-stream",
    ],
  ] as const) {
    const response = await sanitizeMcpResponse(
      new Response(body, { headers: { "content-type": contentType } }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), contentType);
    const text = await response.text();
    assert.equal(text.includes(secret), false);
    if (contentType === "text/event-stream") {
      assert.match(text, /^event: message\ndata: /);
      const message = JSON.parse(text.split("data: ")[1]!);
      assert.equal(message.id, 1);
      assert.equal(message.result.isError, true);
    }
  }
  const good = await sanitizeMcpResponse(
    Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
  );
  assert.equal(good.status, 200);
  assert.deepEqual((await good.json()).result, { tools: [] });

  const chunks = [
    'event: message\ndata: {"jsonrpc":"2.0","id":2,',
    `"error":{"message":"${secret}"}}\n\n`,
  ];
  const streaming = new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const sanitized = await sanitizeMcpResponse(streaming);
  const frame = await sanitized.text();
  assert.equal(frame.includes(secret), false);
  assert.equal(JSON.parse(frame.split("data: ")[1]!).id, 2);

  const unfinished = await sanitizeMcpResponse(
    new Response(
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: 3, error: { message: secret } })}`,
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  assert.equal((await unfinished.text()).includes(secret), false);
});
