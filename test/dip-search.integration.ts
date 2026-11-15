import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  embeddingConfig,
  embeddingInput,
  processNextDipEmbedding,
} from "../src/dip/embedding.js";
import { saveDipEmbedding } from "../src/dip/repository.js";
import { searchDip } from "../src/dip/search.js";
import { EMBED_PROCEEDING } from "../src/dip/jobs.js";
import type { VorgangPage } from "../src/dip/types.js";
import { collectVorgang } from "../src/dip/vorgang.js";
import { isolatedDatabase } from "./dip-test-db.js";

const vector = (first: number, second: number) => [
  first,
  second,
  ...Array.from({ length: 1022 }, () => 0),
];

test("scoped PDF retrieval retains a current citation for every requested proceeding", async () => {
  const prisma = await isolatedDatabase();
  const pdfUrl = "https://dserver.bundestag.de/shared.pdf";
  try {
    for (const [apiId, proceedingApiId] of [
      ["1", "123"],
      ["2", "123"],
      ["3", "124"],
      ["4", "125"],
    ] as const) {
      await prisma.proceedingStep.create({
        data: {
          apiId,
          proceedingApiId,
          institution: "BT",
          stepLabel: "Beratung",
          title: "Shared document",
          documentType: "Drucksache",
          sourceUpdatedAt: new Date("2026-10-14"),
          metadata: {},
          latestVersionNo: 1,
          documentReference: {
            create: {
              proceedingApiId,
              referenceId: "789",
              documentNumber: "21/1001",
              pdfUrl,
              metadata: { herausgeber: "BT", dokumentart: "Drucksache" },
              observedAt: new Date(`2026-10-0${apiId}`),
            },
          },
        },
      });
    }
    const content = await prisma.documentContent.create({
      data: {
        referenceId: "789",
        variantNo: 1,
        byteHash: "shared",
        byteSize: 4,
        pageCount: 3,
        objectKey: "documents/789/shared.pdf",
        requestedUrl: pdfUrl,
      },
    });
    for (const page of [1, 2, 3]) {
      await prisma.documentChunk.create({
        data: {
          contentId: content.id,
          pageNo: page,
          chunkNo: 1,
          text: `Shared page ${page}`,
        },
      });
      await saveDipEmbedding(prisma, {
        sourceEntity: "dokument",
        apiId: "789",
        versionNo: 1,
        sourcePage: page,
        sourceChunk: 1,
        model: embeddingConfig().indexId,
        documentInstruction: embeddingConfig().documentInstruction,
        queryInstruction: embeddingConfig().queryInstruction,
        embedding: vector(1, 0),
      });
    }
    for (const ids of [["123"], ["123", "124"], []]) {
      const hits = await searchDip(prisma, "Shared", 10, {
        embed: async () => vector(1, 0),
        documentProceedingIds: ids,
      });
      assert.equal(hits.length, ids.length * 2);
      for (const id of ids) {
        const pages = hits.filter((hit) => hit.proceedingApiId === id);
        assert.deepEqual(
          pages
            .map((hit) => (hit.entity === "dokument" ? hit.page : null))
            .sort(),
          [1, 2],
        );
        assert.ok(
          pages.every((hit) => hit.source.apiId === (id === "123" ? "2" : "3")),
        );
      }
    }
    const unscoped = await searchDip(prisma, "Shared", 10, {
      embed: async () => vector(1, 0),
    });
    assert.equal(unscoped.length, 2);
    assert.ok(
      unscoped.every(
        (hit) => hit.proceedingApiId === "125" && hit.source.apiId === "4",
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("German and English queries return only current DIP source versions", async () => {
  const prisma = await isolatedDatabase();
  try {
    await prisma.proceeding.create({
      data: {
        apiId: "123",
        title: "Freigabe von Erdölvorräten",
        proceedingType: "Rechtsverordnung",
        electoralTerm: 21,
        sourceUpdatedAt: new Date("2026-10-14T12:00:00Z"),
        metadata: { abstract: "Vorräte des Erdölbevorratungsverbandes" },
        latestVersionNo: 2,
      },
    });
    await prisma.proceedingStep.create({
      data: {
        apiId: "456",
        proceedingApiId: "123",
        institution: "BR",
        stepLabel: "Verordnung der Bundesregierung",
        title: "Freigabe von Erdölvorräten",
        documentType: "Drucksache",
        sourceUpdatedAt: new Date("2026-10-14T12:00:00Z"),
        metadata: { abstract: "Beratung über Erdölreserven" },
        latestVersionNo: 1,
      },
    });
    const save = (
      sourceEntity: "vorgang" | "vorgangsposition",
      sourceApiId: string,
      sourceVersionNo: number,
      embedding: number[],
    ) =>
      saveDipEmbedding(prisma, {
        sourceEntity,
        apiId: sourceApiId,
        versionNo: sourceVersionNo,
        model: embeddingConfig().indexId,
        documentInstruction: embeddingConfig().documentInstruction,
        queryInstruction: embeddingConfig().queryInstruction,
        embedding,
      });
    await save("vorgang", "123", 1, vector(1, 0));
    await save("vorgang", "123", 2, vector(0.8, 0.6));
    await save("vorgangsposition", "456", 1, vector(1, 0));
    const queries: string[] = [];
    const embed = async (text: string) => {
      queries.push(text);
      return vector(1, 0);
    };
    const german = await searchDip(prisma, "Erdölreserven freigeben", 10, {
      embed,
    });
    const english = await searchDip(prisma, "release petroleum reserves", 10, {
      embed,
    });
    await assert.rejects(
      searchDip(prisma, "zero vector", 10, {
        embed: async () => vector(0, 0),
      }),
      /invalid 1024-dimensional embedding/,
    );
    assert.deepEqual(queries, [
      embeddingInput("Erdölreserven freigeben", "query"),
      embeddingInput("release petroleum reserves", "query"),
    ]);
    for (const matches of [german, english]) {
      assert.deepEqual(
        matches.map(({ entity, apiId, versionNo }) => ({
          entity,
          apiId,
          versionNo,
        })),
        [
          { entity: "vorgangsposition", apiId: "456", versionNo: 1 },
          { entity: "vorgang", apiId: "123", versionNo: 2 },
        ],
      );
      assert.deepEqual(matches[0]?.source, {
        endpoint: "/vorgangsposition",
        apiId: "456",
        url: "https://search.dip.bundestag.de/api/v1/vorgangsposition/456",
      });
      assert.equal(matches[0]?.proceedingApiId, "123");
      // Storage-only document fields stay out of proceeding/step results.
      assert.equal("referenceId" in matches[0]!, false);
      assert.equal("pdfUrl" in matches[0]!, false);
      assert.equal("pageNo" in matches[0]!, false);
      assert.equal(
        matches[1]?.summary,
        "Vorräte des Erdölbevorratungsverbandes",
      );
      assert.ok(matches[0]!.score > matches[1]!.score);
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("document text returns the latest variant with page provenance", async () => {
  const prisma = await isolatedDatabase();
  try {
    await prisma.proceedingStep.create({
      data: {
        apiId: "456",
        proceedingApiId: "123",
        institution: "BT",
        stepLabel: "Kleine Anfrage",
        title: "Freigabe von Erdölvorräten",
        documentType: "Drucksache",
        sourceUpdatedAt: new Date("2026-10-14T12:00:00Z"),
        metadata: {},
        latestVersionNo: 1,
      },
    });
    await prisma.documentReference.create({
      data: {
        stepApiId: "456",
        proceedingApiId: "123",
        referenceId: "789",
        documentNumber: "21/1001",
        pdfUrl: "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
        documentDate: new Date("2026-10-09"),
        metadata: { herausgeber: "BT", dokumentart: "Drucksache" },
      },
    });
    const variant = async (variantNo: number, isLatest: boolean) => {
      const content = await prisma.documentContent.create({
        data: {
          referenceId: "789",
          variantNo,
          byteHash: `hash-${variantNo}`,
          byteSize: 4,
          pageCount: 1,
          objectKey: `documents/789/hash-${variantNo}.pdf`,
          requestedUrl: "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
          isLatest,
        },
      });
      await prisma.documentPage.create({
        data: {
          contentId: content.id,
          pageNo: 1,
          text: `Haushalt Fassung ${variantNo}`,
        },
      });
      await prisma.documentChunk.create({
        data: {
          contentId: content.id,
          pageNo: 1,
          chunkNo: 1,
          text: `Haushalt Fassung ${variantNo}`,
        },
      });
      if (variantNo === 2)
        await prisma.documentChunk.create({
          data: {
            contentId: content.id,
            pageNo: 1,
            chunkNo: 2,
            text: "Target budget passage",
          },
        });
      if (variantNo === 2) {
        await prisma.documentPage.create({
          data: { contentId: content.id, pageNo: 2, text: "Second page" },
        });
        await prisma.documentPage.create({
          data: { contentId: content.id, pageNo: 3, text: "Third page" },
        });
        await prisma.documentChunk.createMany({
          data: [
            {
              contentId: content.id,
              pageNo: 1,
              chunkNo: 3,
              text: "Other passage",
            },
            {
              contentId: content.id,
              pageNo: 2,
              chunkNo: 1,
              text: "Second page",
            },
            {
              contentId: content.id,
              pageNo: 3,
              chunkNo: 1,
              text: "Third page",
            },
          ],
        });
      }
      return content;
    };
    await variant(1, false);
    const current = await variant(2, true);
    await prisma.documentSection.create({
      data: {
        contentId: current.id,
        sectionNo: 1,
        label: "A.4",
        title: "Haushalt",
        startPage: 1,
        endPage: 3,
      },
    });
    for (const variantNo of [1, 2])
      await saveDipEmbedding(prisma, {
        sourceEntity: "dokument",
        apiId: "789",
        versionNo: variantNo,
        sourcePage: 1,
        sourceChunk: 1,
        model: embeddingConfig().indexId,
        documentInstruction: embeddingConfig().documentInstruction,
        queryInstruction: embeddingConfig().queryInstruction,
        embedding: variantNo === 1 ? vector(1, 0) : vector(0, 1),
      });

    await saveDipEmbedding(prisma, {
      sourceEntity: "dokument",
      apiId: "789",
      versionNo: 2,
      sourcePage: 1,
      sourceChunk: 2,
      model: embeddingConfig().indexId,
      documentInstruction: embeddingConfig().documentInstruction,
      queryInstruction: embeddingConfig().queryInstruction,
      embedding: vector(1, 0),
    });
    for (const [page, chunk, embedding] of [
      [1, 3, vector(0.9, 0.435)],
      [2, 1, vector(0.8, 0.6)],
      [3, 1, vector(0.7, 0.714)],
    ] as const)
      await saveDipEmbedding(prisma, {
        sourceEntity: "dokument",
        apiId: "789",
        versionNo: 2,
        sourcePage: page,
        sourceChunk: chunk,
        model: embeddingConfig().indexId,
        documentInstruction: embeddingConfig().documentInstruction,
        queryInstruction: embeddingConfig().queryInstruction,
        embedding,
      });
    // Legacy whole-page vectors remain stored but must not enter passage search.
    await saveDipEmbedding(prisma, {
      sourceEntity: "dokument",
      apiId: "789",
      versionNo: 2,
      sourcePage: 1,
      model: embeddingConfig().indexId,
      documentInstruction: embeddingConfig().documentInstruction,
      queryInstruction: embeddingConfig().queryInstruction,
      embedding: vector(1, 0),
    });

    const results = await searchDip(prisma, "Haushalt", 1, {
      embed: async () => vector(1, 0),
    });
    const documents = results.filter((result) => result.entity === "dokument");
    assert.equal(documents.length, 1);
    const document = documents[0];
    if (!document || document.entity !== "dokument") return;
    assert.equal(document.versionNo, 2);
    assert.equal(document.page, 1);
    assert.equal(document.chunk, 2);
    assert.equal(document.passage, "Target budget passage");
    assert.deepEqual(document.excerpt, {
      status: "excerpt-eligible",
      reason: "Confirmed official parliamentary document",
      source: "Deutscher Bundestag/Bundesrat – DIP",
      document: "BT-Drs. 21/1001",
      originalUrl: "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
      page: 1,
      text: "Target budget passage",
      changes: "Text extracted from PDF and excerpted",
    });
    assert.equal(document.proceedingApiId, "123");
    assert.deepEqual(document.document, {
      referenceId: "789",
      number: "21/1001",
      page: 1,
      pdfUrl: "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
      section: { label: "A.4", title: "Haushalt", startPage: 1, endPage: 3 },
    });
    assert.deepEqual(document.source, {
      endpoint: "/vorgangsposition",
      apiId: "456",
      url: "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
    });
    const distinctPages = await searchDip(prisma, "Haushalt", 2, {
      embed: async () => vector(1, 0),
    });
    assert.deepEqual(
      distinctPages.map((result) =>
        result.entity === "dokument"
          ? [result.document.referenceId, result.page, result.chunk]
          : [result.entity, result.apiId],
      ),
      [
        ["789", 1, 2],
        ["789", 2, 1],
      ],
    );
    assert.equal(distinctPages[1]?.entity, "dokument");
    if (distinctPages[1]?.entity === "dokument")
      assert.equal(distinctPages[1].passage, "Second page");
    // Three matching pages exist; the search window keeps the best two.
    assert.equal(
      distinctPages.some(
        (result) => result.entity === "dokument" && result.page === 3,
      ),
      false,
    );
    await prisma.documentReference.update({
      where: { stepApiId: "456" },
      data: { metadata: { herausgeber: "Dritte", dokumentart: "Drucksache" } },
    });
    const linkedThirdParty = await searchDip(prisma, "Haushalt", 1, {
      embed: async () => vector(1, 0),
    });
    const restricted = linkedThirdParty[0];
    assert.equal(restricted?.entity, "dokument");
    if (!restricted || restricted.entity !== "dokument") return;
    assert.equal(restricted.passage, null);
    assert.deepEqual(restricted.excerpt, {
      status: "metadata-only",
      reason: "Unconfirmed official issuer",
    });
    assert.equal(restricted.document.section, null);
    assert.equal("bytes" in restricted, false);
    await prisma.documentReference.update({
      where: { stepApiId: "456" },
      data: {
        pdfUrl: "https://dserver.bundestag.de/btd/21/010/new.pdf",
        metadata: { herausgeber: "BT", dokumentart: "Drucksache" },
      },
    });
    const changedUrl = await searchDip(prisma, "Haushalt", 1, {
      embed: async () => vector(1, 0),
    });
    assert.equal(changedUrl[0]?.entity, "dokument");
    if (changedUrl[0]?.entity !== "dokument") return;
    assert.equal(changedUrl[0].passage, null);
    assert.deepEqual(changedUrl[0].excerpt, {
      status: "metadata-only",
      reason: "Document revision has not been processed",
    });
    assert.equal(changedUrl[0].document.section, null);
  } finally {
    await prisma.$disconnect();
  }
});

test("document search cites matching sections and keeps unrelated pages out of the result", async () => {
  const prisma = await isolatedDatabase();
  try {
    await prisma.proceedingStep.create({
      data: {
        apiId: "456",
        proceedingApiId: "123",
        institution: "BT",
        stepLabel: "Kleine Anfrage",
        title: "Erbschaftsteuer",
        documentType: "Drucksache",
        sourceUpdatedAt: new Date("2026-10-14T12:00:00Z"),
        metadata: {},
        latestVersionNo: 1,
      },
    });
    await prisma.documentReference.create({
      data: {
        stepApiId: "456",
        proceedingApiId: "123",
        referenceId: "789",
        documentNumber: "21/1001",
        pdfUrl: "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
        documentDate: new Date("2026-10-09"),
        metadata: { herausgeber: "BT", dokumentart: "Drucksache" },
      },
    });
    const content = await prisma.documentContent.create({
      data: {
        referenceId: "789",
        variantNo: 1,
        byteHash: "hash-sections",
        byteSize: 4,
        pageCount: 4,
        objectKey: "documents/789/hash-sections.pdf",
        requestedUrl: "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
      },
    });
    await prisma.documentPage.createMany({
      data: [
        { contentId: content.id, pageNo: 2, text: "A.4 Erbschaftsteuer" },
        { contentId: content.id, pageNo: 3, text: "Erbschaftsteuer details" },
        { contentId: content.id, pageNo: 4, text: "B.21 Wärmepläne" },
      ],
    });
    await prisma.documentChunk.createMany({
      data: [
        {
          contentId: content.id,
          pageNo: 2,
          chunkNo: 1,
          text: "A.4 Erbschaftsteuer",
        },
        {
          contentId: content.id,
          pageNo: 3,
          chunkNo: 1,
          text: "Erbschaftsteuer details",
        },
        {
          contentId: content.id,
          pageNo: 4,
          chunkNo: 1,
          text: "B.21 Wärmepläne",
        },
      ],
    });
    await prisma.documentSection.createMany({
      data: [
        {
          contentId: content.id,
          sectionNo: 1,
          label: "A.4",
          title: "Erbschaftsteuer",
          startPage: 2,
          endPage: 3,
        },
        {
          contentId: content.id,
          sectionNo: 2,
          label: "B.21",
          title: "Wärmepläne",
          startPage: 4,
          endPage: 4,
        },
        {
          contentId: content.id,
          sectionNo: 3,
          label: "B.22",
          title: "Weitere Wärmepläne",
          startPage: 4,
          endPage: 4,
        },
      ],
    });
    for (const [page, embedding] of [
      [2, vector(1, 0)],
      [3, vector(0.99, 0.141)],
      [4, vector(0.8, 0.6)],
    ] as const)
      await saveDipEmbedding(prisma, {
        sourceEntity: "dokument",
        apiId: "789",
        versionNo: 1,
        sourcePage: page,
        sourceChunk: 1,
        model: embeddingConfig().indexId,
        documentInstruction: embeddingConfig().documentInstruction,
        queryInstruction: embeddingConfig().queryInstruction,
        embedding,
      });
    const results = await searchDip(prisma, "Erbschaftsteuer", 10, {
      embed: async () => vector(1, 0),
    });
    const documents = results.filter(
      (
        result,
      ): result is Extract<(typeof results)[number], { entity: "dokument" }> =>
        result.entity === "dokument",
    );
    assert.deepEqual(
      documents.map((document) => [
        document.page,
        document.document.section?.label,
        document.document.section?.title,
      ]),
      [
        [2, "A.4", "Erbschaftsteuer"],
        [3, "A.4", "Erbschaftsteuer"],
      ],
    );
    assert.equal(
      documents.some((document) => document.document.section?.label === "B.21"),
      false,
    );
    const sharedPage = await searchDip(prisma, "Wärmepläne", 1, {
      embed: async () => vector(0.8, 0.6),
    });
    assert.equal(sharedPage[0]?.entity, "dokument");
    if (sharedPage[0]?.entity === "dokument") {
      assert.equal(sharedPage[0].page, 4);
      assert.equal(sharedPage[0].document.section, null);
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("search caps evidence per proceeding so one proceeding cannot fill the window", async () => {
  const prisma = await isolatedDatabase();
  try {
    await prisma.proceeding.create({
      data: {
        apiId: "900",
        title: "Omnibus proceeding",
        proceedingType: "Bill",
        electoralTerm: 21,
        sourceUpdatedAt: new Date("2026-10-14T12:00:00Z"),
        metadata: {},
        latestVersionNo: 1,
      },
    });
    for (const apiId of ["1", "2", "3", "4", "5", "6"]) {
      await prisma.proceedingStep.create({
        data: {
          apiId,
          proceedingApiId: "900",
          institution: "BT",
          stepLabel: "Beratung",
          title: "Omnibus proceeding",
          documentType: "Drucksache",
          sourceUpdatedAt: new Date("2026-10-14T12:00:00Z"),
          metadata: {},
          latestVersionNo: 1,
        },
      });
      await saveDipEmbedding(prisma, {
        sourceEntity: "vorgangsposition",
        apiId,
        versionNo: 1,
        model: embeddingConfig().indexId,
        documentInstruction: embeddingConfig().documentInstruction,
        queryInstruction: embeddingConfig().queryInstruction,
        embedding: vector(1, 0),
      });
    }
    const results = await searchDip(prisma, "Omnibus", 10, {
      embed: async () => vector(1, 0),
    });
    assert.deepEqual(
      results.map((result) => [result.entity, result.apiId]),
      [
        ["vorgangsposition", "1"],
        ["vorgangsposition", "2"],
        ["vorgangsposition", "3"],
        ["vorgangsposition", "4"],
        ["vorgangsposition", "5"],
      ],
    );
  } finally {
    await prisma.$disconnect();
  }
});

test(
  "real Qwen embeddings retrieve the same German DIP proceeding from German and English queries",
  { skip: process.env.OLLAMA_QA !== "1" },
  async () => {
    const prisma = await isolatedDatabase();
    try {
      const page = JSON.parse(
        await readFile("fixtures/dip/vorgang-page1.json", "utf8"),
      ) as VorgangPage;
      const collect = (runId: string, documents: unknown[]) =>
        collectVorgang(prisma, {
          runId,
          electoralTerm: 21,
          fetchPage: async () => ({ ...page, documents, cursor: "" }),
        });
      assert.equal(
        (await collect("search-v1", page.documents)).versionsAdded,
        3,
      );
      for (let i = 0; i < 3; i++)
        assert.equal(
          (
            await processNextDipEmbedding(prisma, "search-qa", {
              operation: EMBED_PROCEEDING,
            })
          ).status,
          "succeeded",
        );
      const changed = {
        ...(page.documents[0] as Record<string, unknown>),
        sachgebiet: ["Wirtschaft", "Energie"],
      };
      assert.equal((await collect("search-v2", [changed])).versionsAdded, 1);
      assert.equal(
        (
          await processNextDipEmbedding(prisma, "search-qa", {
            operation: EMBED_PROCEEDING,
          })
        ).status,
        "succeeded",
      );

      for (const query of [
        "Freigabe von Erdölvorräten",
        "release of petroleum reserves",
      ]) {
        const results = await searchDip(prisma, query, 10);
        assert.equal(results[0]?.apiId, "340161");
        assert.equal(results[0]?.versionNo, 2);
        assert.equal(results[0]?.source.endpoint, "/vorgang");
        assert.equal(
          results.filter((result) => result.apiId === "340161").length,
          1,
        );
      }
    } finally {
      await prisma.$disconnect();
    }
  },
);
