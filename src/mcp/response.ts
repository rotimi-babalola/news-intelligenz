// The MCP SDK may echo tool names or validation input in errors.
function sanitizeMessage(message: string): string {
  try {
    const value = JSON.parse(message);
    if (!value || typeof value !== "object") throw new Error();
    if (Array.isArray(value))
      return JSON.stringify(
        value.map((item) => JSON.parse(sanitizeMessage(JSON.stringify(item)))),
      );
    const id =
      typeof value.id === "string" || typeof value.id === "number"
        ? value.id
        : null;
    if (value.error)
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code:
            typeof value.error.code === "number" ? value.error.code : -32603,
          message: "MCP request failed",
        },
      });
    if (value.result?.isError)
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: "MCP tool unavailable" }],
        },
      });
    return message;
  } catch {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "MCP request failed" },
    });
  }
}

function sanitizeFrame(frame: string) {
  return frame
    .split("\n")
    .map((line) =>
      line.startsWith("data: ")
        ? `data: ${sanitizeMessage(line.slice(6))}`
        : line,
    )
    .join("\n");
}

export async function sanitizeMcpResponse(
  response: Response,
): Promise<Response> {
  if (!response.body) return response;
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return new Response(sanitizeMessage(await response.text()), response);

  let pending = "";
  const stream = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          pending += chunk;
          let end: number;
          while ((end = pending.indexOf("\n\n")) !== -1) {
            const frame = pending.slice(0, end);
            pending = pending.slice(end + 2);
            controller.enqueue(sanitizeFrame(frame) + "\n\n");
          }
        },
        flush(controller) {
          if (pending) controller.enqueue(sanitizeFrame(pending));
        },
      }),
    )
    .pipeThrough(new TextEncoderStream());
  return new Response(stream, response);
}
