import { createServer } from "node:http";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { database } from "../src/db";
import { authorizeMcpRequest } from "../src/mcp/auth";
import { proceedingHandler } from "../src/mcp/proceeding";
import { sanitizeMcpResponse } from "../src/mcp/response";

const prisma = database();
const handler = proceedingHandler(prisma);
const nodeHandler = toNodeHandler({
  fetch: async (...args: Parameters<typeof handler.fetch>) => {
    const response = await handler.fetch(...args);
    return args[0].method === "POST" ? sanitizeMcpResponse(response) : response;
  },
});
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
const port = Number(process.env.MCP_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("MCP_PORT must be an integer from 1 to 65535");

const server = createServer(async (request, response) => {
  if (request.url !== "/mcp") {
    response.writeHead(404).end();
    return;
  }
  if (!validateHost(request, response) || !validateOrigin(request, response))
    return;
  try {
    const denied = await authorizeMcpRequest(
      prisma,
      request.headers.authorization,
    );
    if (denied) {
      response
        .writeHead(denied, {
          "Cache-Control": "no-store",
          ...(denied === 429 ? { "Retry-After": "60" } : {}),
        })
        .end(denied === 429 ? "Rate limit exceeded" : "Unauthorized");
      return;
    }
    await nodeHandler(request, response);
  } catch {
    if (!response.headersSent)
      response.writeHead(503).end("Service unavailable");
    else response.destroy();
  }
});
server.listen(port, "127.0.0.1", () =>
  console.error(`MCP listening at http://127.0.0.1:${port}/mcp`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close();
    void handler.close().finally(() => prisma.$disconnect());
  });
