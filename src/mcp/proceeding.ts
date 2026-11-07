import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client";
import { getProceeding } from "../dip/proceeding";
import { searchDip } from "../dip/search";

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
    server.registerTool(
      "search_dip_evidence",
      {
        description:
          "Search current DIP proceedings, steps, and document pages. Results include evidence type, IDs, version, score, source URL, and page when applicable.",
        inputSchema: z.object({
          query: z.string().trim().min(1).max(1000),
          limit: z.number().int().min(1).max(20).default(10),
        }),
      },
      async ({ query, limit }) => {
        try {
          const results = await searchDip(prisma, query, limit);
          return {
            content: [{ type: "text", text: JSON.stringify({ results }) }],
          };
        } catch (error) {
          const message =
            error instanceof TypeError && error.message === "fetch failed"
              ? "embedding provider unreachable"
              : error instanceof Error
                ? error.message
                : "unknown error";
          return {
            content: [
              {
                type: "text",
                text: `DIP search unavailable: ${message}`,
              },
            ],
            isError: true,
          };
        }
      },
    );
    return server;
  });
}
