import { database } from "../src/db.js";
import { processNextDocument } from "../src/dip/documents.js";
import {
  embeddingCost,
  processNextDipEmbedding,
} from "../src/dip/embedding.js";

function cap(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

const documentCap = cap("DIP_DOCUMENT_DRAIN_CAP", 100);
const embeddingCap = cap("DIP_EMBEDDING_DRAIN_CAP", 500);
const prisma = database();
try {
  const counts = { documents: 0, embeddings: 0, retrying: 0, exhausted: 0 };
  for (let i = 0; i < documentCap; i++) {
    const result = await processNextDocument(prisma, "cron-drain-documents");
    if (result.status === "empty") break;
    counts.documents++;
    if (result.status === "retrying") counts.retrying++;
    if (result.status === "exhausted") counts.exhausted++;
  }
  for (let i = 0; i < embeddingCap; i++) {
    const result = await processNextDipEmbedding(
      prisma,
      "cron-drain-embeddings",
      { reindexOnly: process.env.DIP_EMBEDDING_REINDEX_ONLY === "1" },
    );
    if (result.status === "empty") break;
    counts.embeddings++;
    if (result.status === "retrying") {
      counts.retrying++;
      break; // A provider outage or rate limit must not consume the queue's retry budget.
    }
    if (result.status === "exhausted") counts.exhausted++;
  }
  console.log({ ...counts, ...embeddingCost() });
  if (counts.retrying || counts.exhausted) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
