import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { PrismaClient, Prisma } from "../generated/prisma/client";

// shortcut: character bounds are not token bounds; use the model tokenizer if a provider rejects these passages.
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1200,
  chunkOverlap: 200,
});

export const splitDocumentPage = (text: string) =>
  splitter.splitText(text.trim());

export async function ensureDocumentChunks(
  prisma: PrismaClient | Prisma.TransactionClient,
  contentId: string,
  pages: { pageNo: number; text: string }[],
) {
  for (const page of pages) {
    const chunks = await splitDocumentPage(page.text);
    if (!chunks.length) continue;
    await prisma.documentChunk.createMany({
      data: chunks.map((text, index) => ({
        contentId,
        pageNo: page.pageNo,
        chunkNo: index + 1,
        text,
      })),
      skipDuplicates: true,
    });
  }
  return prisma.documentChunk.findMany({
    where: { contentId },
    orderBy: [{ pageNo: "asc" }, { chunkNo: "asc" }],
  });
}
