import assert from "node:assert/strict";
import { test } from "node:test";
import { processNextDocument } from "../src/dip/documents.js";
import { collectSteps } from "../src/dip/steps.js";
import { isolatedDatabase } from "./dip-test-db.js";

const NOW = new Date("2026-10-20T12:00:00+02:00");
const PDF_URL = "https://dserver.bundestag.de/btd/21/010/2110010.pdf";
const HOT = "2026-10-09";

// Tests never reach R2; every case injects a recording putPdf.
type ProcessOptions = NonNullable<Parameters<typeof processNextDocument>[2]>;
function processDoc(
  prisma: Parameters<typeof processNextDocument>[0],
  workerId: string,
  options: ProcessOptions = {},
) {
  return processNextDocument(prisma, workerId, {
    putPdf: async () => {},
    ...options,
  });
}

function step(id: string, pdfUrl: string | null = PDF_URL) {
  return {
    id,
    typ: "Vorgangsposition",
    vorgangsposition: "Kleine Anfrage",
    zuordnung: "BT",
    gang: false,
    fortsetzung: false,
    nachtrag: false,
    vorgangstyp: "Kleine Anfrage",
    titel: "Titel 340135",
    dokumentart: "Drucksache",
    vorgang_id: "340135",
    datum: HOT,
    aktualisiert: `${HOT}T13:24:22+02:00`,
    fundstelle: {
      id: "29701499",
      dokumentnummer: "21/1001",
      datum: HOT,
      ...(pdfUrl ? { pdf_url: pdfUrl } : {}),
    },
    aktivitaet_anzahl: 0,
  };
}

function collect(
  prisma: Awaited<ReturnType<typeof isolatedDatabase>>,
  runId: string,
  document = step("701400"),
) {
  return collectSteps(prisma, {
    runId,
    electoralTerm: 21,
    now: NOW,
    fetchPage: async () => ({
      documents: [document],
      cursor: "x",
      numFound: 1,
    }),
  });
}

test("document variants derive section outlines and changed bytes refresh them", async () => {
  const prisma = await isolatedDatabase();
  try {
    await collect(prisma, "doc-sections-1");
    const firstPages = [
      { page: 1, text: "Deutscher Bundestag Drucksache 21/1001" },
      { page: 2, text: "A.4 Steuerliche Behandlung\nText" },
      { page: 3, text: "Weitere Ausführungen" },
      { page: 4, text: "B.21 Förderung kommunaler Wärmepläne\nText" },
    ];
    assert.equal(
      (
        await processDoc(prisma, "worker", {
          fetchPdf: async () => ({
            ok: true,
            bytes: Buffer.from("%PDF sections one"),
            finalUrl: PDF_URL,
          }),
          extract: async () => firstPages,
        })
      ).status,
      "succeeded",
    );
    const first = await prisma.documentContent.findFirstOrThrow({
      where: { isLatest: true },
    });
    const firstSections = await prisma.documentSection.findMany({
      where: { contentId: first.id },
      orderBy: { sectionNo: "asc" },
    });
    assert.deepEqual(
      firstSections.map((section) => [
        section.label,
        section.title,
        section.startPage,
        section.endPage,
      ]),
      [
        ["A.4", "Steuerliche Behandlung", 2, 3],
        ["B.21", "Förderung kommunaler Wärmepläne", 4, 4],
      ],
    );

    // Changed bytes become a new variant with a fresh outline; the earlier
    // variant keeps its own outline but is no longer current.
    await collect(prisma, "doc-sections-2", step("701400", `${PDF_URL}?v=2`));
    assert.equal(
      (
        await processDoc(prisma, "worker", {
          fetchPdf: async () => ({
            ok: true,
            bytes: Buffer.from("%PDF sections two"),
            finalUrl: PDF_URL,
          }),
          extract: async () => [
            { page: 1, text: "A.4 Neue Fassung\nText" },
            { page: 2, text: "Anlage" },
          ],
        })
      ).status,
      "succeeded",
    );
    const contents = await prisma.documentContent.findMany({
      orderBy: { variantNo: "asc" },
    });
    assert.deepEqual(
      contents.map((content) => [content.variantNo, content.isLatest]),
      [
        [1, false],
        [2, true],
      ],
    );
    const secondSections = await prisma.documentSection.findMany({
      where: { contentId: contents[1]!.id },
      orderBy: { sectionNo: "asc" },
    });
    assert.deepEqual(
      secondSections.map((section) => [
        section.label,
        section.title,
        section.startPage,
        section.endPage,
      ]),
      [["A.4", "Neue Fassung", 1, 2]],
    );
    assert.equal(
      await prisma.documentSection.count({
        where: { contentId: contents[0]!.id },
      }),
      2,
    );

    // A variant without headings stays explicitly outlineless.
    await collect(prisma, "doc-sections-3", step("701400", `${PDF_URL}?v=3`));
    assert.equal(
      (
        await processDoc(prisma, "worker", {
          fetchPdf: async () => ({
            ok: true,
            bytes: Buffer.from("%PDF sections three"),
            finalUrl: PDF_URL,
          }),
          extract: async () => [
            { page: 1, text: "Nur Fließtext ohne Gliederung" },
            { page: 2, text: "A.4" },
          ],
        })
      ).status,
      "succeeded",
    );
    const plain = await prisma.documentContent.findFirstOrThrow({
      where: { isLatest: true },
    });
    assert.equal(plain.variantNo, 3);
    assert.equal(
      await prisma.documentSection.count({ where: { contentId: plain.id } }),
      0,
    );
  } finally {
    await prisma.$disconnect();
  }
});
