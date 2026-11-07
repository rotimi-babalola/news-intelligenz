import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client";
import { getProceeding } from "../dip/proceeding";
import { searchDip } from "../dip/search";
import { getDocumentPages } from "../dip/document-pages";

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
      "get_document_pages",
      {
        description:
          "Read up to 3 stored pages from the latest eligible DIP document variant. Each page excerpt is at most 2000 characters; unavailable documents are never fetched or queued.",
        inputSchema: z.object({
          referenceId: z.string().regex(/^\d+$/),
          startPage: z.number().int().min(1).default(1),
          limit: z.number().int().min(1).max(3).default(3),
        }),
      },
      async ({ referenceId, startPage, limit }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await getDocumentPages(prisma, referenceId, startPage, limit),
            ),
          },
        ],
      }),
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
