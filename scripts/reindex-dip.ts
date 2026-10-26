import { database } from "../src/db.js";
import { embeddingConfig } from "../src/dip/embedding.js";
import { enqueueDipReindex } from "../src/dip/reindex.js";

const prisma = database();
try {
  const model = embeddingConfig().indexId;
  const samplePercent = Number(process.env.DIP_REINDEX_SAMPLE_PERCENT ?? "10");
  console.log(model, await enqueueDipReindex(prisma, model, samplePercent));
} finally {
  await prisma.$disconnect();
}
