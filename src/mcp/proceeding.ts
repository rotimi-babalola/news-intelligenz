import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client";
import { getProceeding } from "../dip/proceeding";

export function proceedingHandler(prisma: PrismaClient) {
  return createMcpHandler(() => {
    const server = new McpServer({
      name: "news-intelligenz",
      version: "1.0.0",
    });
    server.registerTool(
      "get_proceeding",
      {
        description:
          "Read the current DIP proceeding and its ordered steps and document references",
        inputSchema: z.object({ apiId: z.string().regex(/^\d+$/) }),
      },
      async ({ apiId }) => {
        const result = await getProceeding(prisma, apiId);
        return result
          ? { content: [{ type: "text", text: JSON.stringify(result) }] }
          : {
              content: [
                { type: "text", text: `Proceeding ${apiId} was not found` },
              ],
              isError: true,
            };
      },
    );
    return server;
  });
}
