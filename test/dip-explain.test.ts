import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { buildDossiers } from "../src/dip/dossiers.js";
import { generateProceedingBrief, validateAnswer } from "../src/dip/explain.js";
import type { ProceedingTimeline } from "../src/dip/proceeding.js";
import type { DipHit } from "../src/dip/search.js";

const date = new Date("2026-10-10T00:00:00.000Z");
const pdfUrl = "https://example.org/document.pdf";
const timeline: ProceedingTimeline = {
  apiId: "1",
  parentMissing: false,
  proceeding: {
    title: "Housing bill",
    type: "Bill",
    deliberationState: null,
    summary: null,
    documentDate: null,
    sourceUpdatedAt: date.toISOString(),
    firstObservedAt: date.toISOString(),
    lastObservedAt: date.toISOString(),
    versionNo: 1,
    versionId: "p1",
    versionObservedAt: date.toISOString(),
    sourceUrl: "https://example.org/proceeding/1",
  },
  steps: [
    {
      apiId: "2",
      institution: "BT",
      label: "First reading",
      title: "Housing bill introduced",
      text: null,
      documentType: "Drucksache",
      documentDate: date.toISOString(),
      sourceUpdatedAt: date.toISOString(),
      firstObservedAt: date.toISOString(),
      lastObservedAt: date.toISOString(),
      versionNo: 1,
      versionId: "s1",
      versionObservedAt: date.toISOString(),
      sourceUrl: "https://example.org/step/2",
      document: {
        referenceId: "3",
        number: "1/1",
        date: null,
        pdfUrl,
        metadata: {},
        observedAt: date.toISOString(),
      },
    },
  ],
};
const hit = {
  entity: "dokument",
  apiId: "3",
  proceedingApiId: "1",
  versionNo: 1,
  score: 0.8,
  title: "1/1",
  summary: null,
  stepLabel: null,
  page: 2,
  chunk: 1,
  passage: "The bill would provide housing grants.",
  excerpt: {
    status: "excerpt-eligible",
    text: "The bill would provide housing grants.",
    page: 2,
    originalUrl: pdfUrl,
  },
  document: { referenceId: "3", number: "1/1", page: 2, pdfUrl, section: null },
  source: { endpoint: "/vorgangsposition", apiId: "2", url: pdfUrl },
} as DipHit;
const dossier = buildDossiers([hit], new Map([["1", timeline]]), 1)[0]!;

function store() {
  let proceedingVersion = 1;
  let variantNo = 1;
  let byteHash = "hash-one";
  const briefs = new Map<string, unknown>();
  const prisma = {
    proceeding: {
      findUnique: async () => ({
        apiId: "1",
        title: "Housing bill",
        proceedingType: "Bill",
        deliberationState: null,
        metadata: {},
        documentDate: null,
        sourceUpdatedAt: date,
        firstObservedAt: date,
        lastObservedAt: date,
        latestVersionNo: proceedingVersion,
        versions: [{ id: "p1", observedAt: date }],
      }),
    },
    proceedingStep: {
      findMany: async () => [
        {
          apiId: "2",
          institution: "BT",
          stepLabel: "First reading",
          title: "Housing bill introduced",
          documentType: "Drucksache",
          documentDate: date,
          sourceUpdatedAt: date,
          firstObservedAt: date,
          lastObservedAt: date,
          metadata: {},
          latestVersionNo: 1,
          versions: [{ id: "s1", observedAt: date }],
          documentReference: {
            referenceId: "3",
            documentNumber: "1/1",
            documentDate: null,
            pdfUrl,
            metadata: {},
            observedAt: date,
          },
        },
      ],
    },
    documentContent: {
      findFirst: async () => ({
        id: "content-one",
        variantNo,
        byteHash,
        requestedUrl: pdfUrl,
      }),
    },
    documentChunk: {
      findUnique: async () => ({
        text: "The bill would provide housing grants.",
      }),
    },
    proceedingBrief: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        briefs.has(where.key) ? { answer: briefs.get(where.key) } : null,
      upsert: async ({
        create,
      }: {
        create: { key: string; answer: unknown };
      }) => {
        briefs.set(create.key, create.answer);
      },
    },
  } as unknown as PrismaClient;
  return {
    prisma,
    briefs,
    setVersion: (value: number) => {
      proceedingVersion = value;
    },
    setVariant: (number: number, hash: string) => {
      variantNo = number;
      byteHash = hash;
    },
  };
}

const answer = (language: "en" | "de") => ({
  matter: [
    {
      text:
        language === "en"
          ? "A housing bill was introduced."
          : "Ein Wohnungsgesetz wurde eingebracht.",
      evidenceId: "step:2",
      quote: "Housing bill introduced",
    },
  ],
  stage: [
    {
      text:
        language === "en"
          ? "It reached a first reading."
          : "Es erreichte die erste Lesung.",
      evidenceId: "step:2",
      quote: "First reading",
    },
  ],
  steps: [
    {
      text:
        language === "en"
          ? "The first reading is documented."
          : "Die erste Lesung ist dokumentiert.",
      evidenceId: "step:2",
      quote: "First reading",
    },
  ],
  documents: [
    {
      text:
        language === "en"
          ? "The document proposes housing grants."
          : "Das Dokument schlägt Wohnbeihilfen vor.",
      evidenceId: "page:3:2",
      quote: "The bill would provide housing grants.",
    },
  ],
  unresolved: [],
});

test("English and German briefs cite the same stored step and document page", async () => {
  const { prisma } = store();
  for (const language of ["en", "de"] as const) {
    const brief = await generateProceedingBrief(
      prisma,
      "What happened?",
      language,
      dossier,
      async () => answer(language),
    );
    assert.equal(brief.answerConfidence, "partial");
    assert.equal(brief.claims.stage[0]?.citation.stepId, "2");
    assert.deepEqual(brief.claims.documents[0]?.citation, {
      kind: "page",
      stepId: "2",
      referenceId: "3",
      page: 2,
      url: pdfUrl,
    });
    assert.equal(brief.retrievalRelevance, 0.8);
  }
});

test("unsupported citations and missing evidence produce a qualified answer or abstention", async () => {
  const { prisma, setVariant } = store();
  const unsupported = validateAnswer(
    {
      ...answer("en"),
      documents: [
        {
          text: "Invented",
          evidenceId: "page:3:2",
          quote: "not in the passage",
        },
      ],
    },
    [
      {
        id: "page:3:2",
        text: "The bill would provide housing grants.",
        citation: {
          kind: "page",
          stepId: "2",
          referenceId: "3",
          page: 2,
          url: pdfUrl,
        },
      },
    ],
  );
  assert.deepEqual(unsupported.documents, []);
  setVariant(2, "hash-two");
  const brief = await generateProceedingBrief(
    prisma,
    "What does the document say?",
    "en",
    dossier,
    async () => ({
      matter: [],
      stage: [],
      steps: [],
      documents: [],
      unresolved: [],
    }),
  );
  assert.equal(brief.answerConfidence, "abstain");
  assert.deepEqual(brief.claims.documents, []);
  assert.match(brief.qualification!, /does not establish/);
});

test("ineligible document passages cannot support document claims", async () => {
  const { prisma } = store();
  const ineligible = buildDossiers(
    [
      {
        ...hit,
        excerpt: { status: "metadata-only", reason: "Unconfirmed issuer" },
      } as DipHit,
    ],
    new Map([["1", timeline]]),
    1,
  )[0]!;
  const brief = await generateProceedingBrief(
    prisma,
    "What does the document say?",
    "de",
    ineligible,
    async () => answer("de"),
  );
  assert.deepEqual(brief.claims.documents, []);
  assert.equal(brief.answerConfidence, "partial");
});

test("cached briefs regenerate for each language and changed PDF evidence", async () => {
  const { prisma, briefs, setVariant } = store();
  let calls = 0;
  const generate = async () => {
    calls++;
    return answer("en");
  };
  await generateProceedingBrief(prisma, "Question", "en", dossier, generate);
  await generateProceedingBrief(prisma, "Question", "en", dossier, generate);
  assert.equal(calls, 1);
  await generateProceedingBrief(prisma, "Question", "de", dossier, generate);
  assert.equal(calls, 2);
  setVariant(2, "hash-two");
  await generateProceedingBrief(prisma, "Question", "en", dossier, generate);
  assert.equal(calls, 3);
  assert.equal(briefs.size, 3);
});

test("a changed proceeding version rejects a stale dossier", async () => {
  const { prisma, setVersion, briefs } = store();
  let calls = 0;
  const generate = async () => {
    calls++;
    return answer("en");
  };
  await generateProceedingBrief(prisma, "Question", "en", dossier, generate);
  setVersion(2);
  await assert.rejects(
    generateProceedingBrief(prisma, "Question", "en", dossier, generate),
    /Dossier changed/,
  );
  const updated = buildDossiers(
    [hit],
    new Map([
      [
        "1",
        { ...timeline, proceeding: { ...timeline.proceeding!, versionNo: 2 } },
      ],
    ]),
    1,
  )[0]!;
  await generateProceedingBrief(prisma, "Question", "en", updated, generate);
  assert.equal(calls, 2);
  assert.equal(briefs.size, 2);
});
