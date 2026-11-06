import { createServer } from "node:http";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { database } from "../src/db";
import { proceedingHandler } from "../src/mcp/proceeding";

const prisma = database();
const handler = proceedingHandler(prisma);
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
const port = Number(process.env.MCP_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("MCP_PORT must be an integer from 1 to 65535");

const server = createServer((request, response) => {
  if (request.url !== "/mcp") {
    response.writeHead(404).end();
    return;
  }
  if (!validateHost(request, response) || !validateOrigin(request, response))
    return;
  void nodeHandler(request, response);
});
server.listen(port, "127.0.0.1", () =>
  console.error(`MCP listening at http://127.0.0.1:${port}/mcp`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close();
    void handler.close().finally(() => prisma.$disconnect());
  });
