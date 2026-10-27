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
  const existing = await prisma.documentChunk.findMany({
    where: { contentId },
    orderBy: [{ pageNo: "asc" }, { chunkNo: "asc" }],
  });
  const storedPages = new Set(existing.map((chunk) => chunk.pageNo));
  let added = false;
  let pending: Prisma.DocumentChunkCreateManyInput[] = [];
  const flush = async () => {
    if (!pending.length) return;
    await prisma.documentChunk.createMany({
      data: pending,
      skipDuplicates: true,
    });
    pending = [];
    added = true;
  };
  for (const page of pages) {
    if (storedPages.has(page.pageNo)) continue;
    const chunks = await splitDocumentPage(page.text);
    if (!chunks.length) continue;
    // shortcut: an unusually large single page can exceed the batch size; split it only if database limits require it.
    if (pending.length + chunks.length > 500) await flush();
    pending.push(
      ...chunks.map((text, index) => ({
        contentId,
        pageNo: page.pageNo,
        chunkNo: index + 1,
        text,
      })),
    );
  }
  await flush();
  if (!added) return existing;
  return prisma.documentChunk.findMany({
    where: { contentId },
    orderBy: [{ pageNo: "asc" }, { chunkNo: "asc" }],
  });
}
