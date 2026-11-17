import { database } from "../src/db.js";
import { processNextDocument } from "../src/dip/documents/process.js";
import { embeddingCost } from "../src/dip/search/embedding.js";
import { drainDipEmbeddings } from "../src/dip/jobs/embedding.js";
import { PermanentJobError } from "../src/jobs/index.js";

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
  const counts = {
    documents: 0,
    embeddings: 0,
    retrying: 0,
    exhausted: 0,
    permanent: 0,
  };
  // Documents stay one call per job: the document cap is small, so the extra
  // recovery pass per job costs seconds, and embeddings are where the time is.
  for (let i = 0; i < documentCap; i++) {
    const result = await processNextDocument(prisma, "cron-drain-documents", {
      onExhausted: (_job, error) => {
        if (error instanceof PermanentJobError) counts.permanent++;
      },
    });
    if (result.status === "empty") break;
    counts.documents++;
    if (result.status === "retrying") counts.retrying++;
    if (result.status === "exhausted") counts.exhausted++;
  }
  const embeddings = await drainDipEmbeddings(prisma, "cron-drain-embeddings", {
    limit: embeddingCap,
    reindexOnly: process.env.DIP_EMBEDDING_REINDEX_ONLY === "1",
  });
  counts.embeddings = embeddings.length;
  for (const result of embeddings) {
    if (result.status === "retrying") counts.retrying++;
    if (result.status === "exhausted") counts.exhausted++;
  }
  console.log({ ...counts, ...embeddingCost() });
  // A source link that never existed is a record-level gap, not a pipeline
  // failure: it leaves the queue on the first attempt and must not fail the run.
  if (counts.retrying || counts.exhausted > counts.permanent)
    process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
