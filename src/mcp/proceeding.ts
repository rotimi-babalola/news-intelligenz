import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client";
import { getProceeding } from "../dip/proceedings/timeline";
import { searchProceedingDossiers } from "../dip/search/dossiers";
import { getDocumentPages } from "../dip/documents/pages";
import { verifyDocumentSection } from "../dip/documents/verify";

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
        try {
          const result = await getProceeding(prisma, apiId);
          return result
            ? { content: [{ type: "text", text: JSON.stringify(result) }] }
            : {
                content: [
                  { type: "text", text: `Proceeding ${apiId} was not found` },
                ],
                isError: true,
              };
        } catch {
          return {
            content: [{ type: "text", text: "DIP read unavailable" }],
            isError: true,
          };
        }
      },
    );
    server.registerTool(
      "get_document_pages",
      {
        description:
          "Read up to 3 stored pages from the latest eligible DIP document variant, plus its section outline with page ranges. Each page excerpt is at most 2000 characters; unavailable documents are never fetched or queued.",
        inputSchema: z.object({
          referenceId: z.string().regex(/^\d+$/),
          startPage: z.number().int().min(1).default(1),
          limit: z.number().int().min(1).max(3).default(3),
        }),
      },
      async ({ referenceId, startPage, limit }) => {
        try {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  await getDocumentPages(prisma, referenceId, startPage, limit),
                ),
              },
            ],
          };
        } catch {
          return {
            content: [{ type: "text", text: "DIP read unavailable" }],
            isError: true,
          };
        }
      },
    );
    server.registerTool(
      "verify_document_section",
      {
        description:
          "Check a detected section heading and its boundary against the archived current PDF before citing the section. Verify a proposed quote on a page inside the returned range separately.",
        inputSchema: z.object({
          referenceId: z.string().regex(/^\d+$/),
          sectionNo: z.number().int().min(1),
        }),
      },
      async ({ referenceId, sectionNo }) => {
        try {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  await verifyDocumentSection(prisma, referenceId, sectionNo),
                ),
              },
            ],
          };
        } catch {
          return {
            content: [{ type: "text", text: "DIP read unavailable" }],
            isError: true,
          };
        }
      },
    );
    server.registerTool(
      "search_dip_evidence",
      {
        description:
          "Search current DIP proceeding dossiers with ranked evidence, source links, and ordered step timelines.",
        inputSchema: z.object({
          query: z.string().trim().min(1).max(1000),
          limit: z.number().int().min(1).max(20).default(10),
        }),
      },
      async ({ query, limit }) => {
        try {
          const results = await searchProceedingDossiers(prisma, query, limit);
          return {
            content: [{ type: "text", text: JSON.stringify({ results }) }],
          };
        } catch {
          return {
            content: [
              {
                type: "text",
                text: "DIP search unavailable",
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
