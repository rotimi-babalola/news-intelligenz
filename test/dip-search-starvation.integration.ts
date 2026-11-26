import assert from "node:assert/strict";
import { test } from "node:test";
import { DIP_SEARCH_CANDIDATE_LIMIT } from "../src/dip/constants.js";
import { saveDipEmbedding } from "../src/dip/db/index.js";
import { embeddingConfig } from "../src/dip/search/embedding.js";
import { searchDip } from "../src/dip/search/search.js";
import { isolatedDatabase } from "./dip-test-db.js";

const vector = (first: number, second: number) => [
  first,
  second,
  ...Array.from({ length: 1022 }, () => 0),
];
const pdfUrl = "https://dserver.bundestag.de/starvation.pdf";
const date = new Date("2026-10-14");
const count = DIP_SEARCH_CANDIDATE_LIMIT + 1;

type Database = Awaited<ReturnType<typeof isolatedDatabase>>;

async function seedReference(
  prisma: Database,
  stepApiId: string,
  proceedingApiId: string,
  referenceId: string,
) {
  await prisma.proceedingStep.create({
    data: {
      apiId: stepApiId,
      proceedingApiId,
      institution: "BT",
      stepLabel: "Beratung",
      title: `Document ${referenceId}`,
      documentType: "Drucksache",
      sourceUpdatedAt: date,
      metadata: {},
      latestVersionNo: 1,
      documentReference: {
        create: {
          proceedingApiId,
          referenceId,
          documentNumber: `21/${stepApiId}`,
          pdfUrl,
          metadata: { herausgeber: "BT", dokumentart: "Drucksache" },
          observedAt: date,
        },
      },
    },
  });
}

async function seedVariant(
  prisma: Database,
  input: {
    referenceId: string;
    variantNo: number;
    pages: number;
    embedding: number[];
    model?: string;
    isLatest?: boolean;
  },
) {
  const content = await prisma.documentContent.create({
    data: {
      referenceId: input.referenceId,
      variantNo: input.variantNo,
      byteHash: `hash-${input.referenceId}-${input.variantNo}`,
      byteSize: 4,
      pageCount: input.pages,
      objectKey: `documents/${input.referenceId}-${input.variantNo}.pdf`,
      requestedUrl: pdfUrl,
      isLatest: input.isLatest ?? true,
    },
  });
  const config = embeddingConfig();
  await prisma.documentChunk.createMany({
    data: Array.from({ length: input.pages }, (_, index) => ({
      contentId: content.id,
      pageNo: index + 1,
      chunkNo: 1,
      text: `${input.referenceId} page ${index + 1}`,
    })),
  });
  for (let page = 1; page <= input.pages; page++)
    await saveDipEmbedding(prisma, {
      sourceEntity: "dokument",
      apiId: input.referenceId,
      versionNo: input.variantNo,
      sourcePage: page,
      sourceChunk: 1,
      model: input.model ?? config.indexId,
      documentInstruction: config.documentInstruction,
      queryInstruction: config.queryInstruction,
      embedding: input.embedding,
    });
  return content;
}

test("superseded pages cannot exhaust the scoped candidate window", async () => {
  const prisma = await isolatedDatabase();
  try {
    await seedReference(prisma, "1", "123", "doc-a");
    await seedVariant(prisma, {
      referenceId: "doc-a",
      variantNo: 1,
      pages: count,
      embedding: vector(1, 0),
      isLatest: false,
    });
    await seedVariant(prisma, {
      referenceId: "doc-a",
      variantNo: 2,
      pages: 1,
      embedding: vector(0, 1),
    });

    const scoped = await searchDip(prisma, "Superseded", 5, {
      embed: async () => vector(1, 0),
      documentProceedingIds: ["123"],
    });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]?.versionNo, 2);
    assert.equal(scoped[0]?.page, 1);
  } finally {
    await prisma.$disconnect();
  }
});

test("one document-heavy proceeding cannot hide another requested proceeding", async () => {
  const prisma = await isolatedDatabase();
  try {
    await seedReference(prisma, "1", "123", "doc-a");
    await seedVariant(prisma, {
      referenceId: "doc-a",
      variantNo: 1,
      pages: count,
      embedding: vector(1, 0),
    });
    await seedReference(prisma, "2", "124", "doc-b");
    await seedVariant(prisma, {
      referenceId: "doc-b",
      variantNo: 1,
      pages: 1,
      embedding: vector(0, 1),
    });

    const scoped = await searchDip(prisma, "Scoped", 10, {
      embed: async () => vector(1, 0),
      documentProceedingIds: ["123", "124"],
    });
    assert.deepEqual(
      [...new Set(scoped.map((hit) => hit.proceedingApiId))].sort(),
      ["123", "124"],
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("another embedding configuration cannot make the indexed search return nothing", async () => {
  const prisma = await isolatedDatabase();
  try {
    await seedReference(prisma, "1", "123", "doc-a");
    await seedVariant(prisma, {
      referenceId: "doc-a",
      variantNo: 1,
      pages: count,
      embedding: vector(1, 0),
      model: "other-embedding-config",
    });
    const config = embeddingConfig();
    await saveDipEmbedding(prisma, {
      sourceEntity: "dokument",
      apiId: "doc-a",
      versionNo: 1,
      sourcePage: 1,
      sourceChunk: 1,
      model: config.indexId,
      documentInstruction: config.documentInstruction,
      queryInstruction: config.queryInstruction,
      embedding: vector(0, 1),
    });

    const hits = await searchDip(prisma, "Mixed configuration", 5, {
      embed: async () => vector(1, 0),
    });
    assert.ok(
      hits.some((hit) => hit.entity === "dokument" && hit.apiId === "doc-a"),
    );
  } finally {
    await prisma.$disconnect();
  }
});
