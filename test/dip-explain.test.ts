import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import {
  addDocumentEvidence,
  buildDossiers,
} from "../src/dip/search/dossier-builders.js";
import {
  generateProceedingBrief,
  validateAnswer,
  type ExplainerProvider,
} from "../src/dip/explain/index.js";
import {
  chatCompletionsProvider,
  type Generate,
  type Translate,
  type TranslateTerms,
  type Verify,
} from "../src/dip/explain/provider.js";
import {
  alignDocumentClaims,
  selectedAnswerClaims,
} from "../src/dip/explain/claims.js";
import { missingFacts } from "../src/dip/explain/citations.js";
import { stepSource } from "../src/dip/explain/evidence.js";
import type { ProceedingTimeline } from "../src/dip/proceedings/timeline.js";
import type { DipHit } from "../src/dip/search/search.js";

const approveFixtureClaims: Verify = async ({ claims }) => ({
  supportedClaimIds: claims.map(({ id }) => id),
});

function fixtureProvider(
  generate: Generate,
  translate: Translate = async () => ({ claims: [] }),
  identity = "fixture",
  translateTerms: TranslateTerms = async ({ terms }) => ({ terms }),
): ExplainerProvider {
  return {
    generate,
    verify: approveFixtureClaims,
    translate,
    translateTerms,
    identity,
  };
}

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

function store(
  noSteps = false,
  stepLabel = "First reading",
  stepTitle = "Housing bill introduced",
) {
  let proceedingVersion = 1;
  let variantNo = 1;
  let byteHash = "hash-one";
  let requestedUrl = pdfUrl;
  const briefs = new Map<string, unknown>();
  const reads = { variants: 0, chunks: 0, pages: 0 };
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
      findMany: async () =>
        noSteps
          ? []
          : [
              {
                apiId: "2",
                institution: "BT",
                stepLabel,
                title: stepTitle,
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
        requestedUrl,
      }),
      findMany: async () => {
        reads.variants++;
        return [
          {
            id: "content-one",
            referenceId: "3",
            variantNo,
            byteHash,
            requestedUrl,
          },
        ];
      },
    },
    documentChunk: {
      findUnique: async () => {
        reads.chunks++;
        return { text: "The bill would provide housing grants." };
      },
    },
    documentPage: {
      findUnique: async () => {
        reads.pages++;
        return {
          text: "The bill would provide housing grants. It also funds demolition.",
        };
      },
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
    reads,
    setVersion: (value: number) => {
      proceedingVersion = value;
    },
    setVariant: (number: number, hash: string) => {
      variantNo = number;
      byteHash = hash;
    },
    setRequestedUrl: (value: string) => {
      requestedUrl = value;
    },
  };
}

const answer = (language: "en" | "de") => ({
  answer: [
    {
      text:
        language === "en"
          ? "The bill is at its first reading."
          : "Das Gesetz befindet sich in der ersten Lesung.",
      evidenceId: "step:2",
      quote: "First reading",
    },
  ],
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
      { question: "What happened?", language: language, dossier: dossier },
      fixtureProvider(async () => answer(language)),
    );
    assert.equal(brief.answerConfidence, "partial");
    assert.equal(brief.claims.answer[0]?.citation.stepId, "2");
    assert.equal(brief.claims.stage[0]?.citation.stepId, "2");
    assert.equal(brief.claims.stage[0]?.citation.url, "/source/step/2");
    assert.deepEqual(brief.claims.documents[0]?.citation, {
      kind: "page",
      stepId: "2",
      referenceId: "3",
      page: 2,
      url: "/source/document/3?page=2&step=2",
      pdfUrl: `${pdfUrl}#page=2`,
    });
    assert.equal(brief.retrievalRelevance, 0.8);
  }
});

test("an orphan dossier abstains without calling the provider", async () => {
  const { prisma } = store();
  const orphan = buildDossiers(
    [{ ...hit, proceedingApiId: "9" }],
    new Map([
      ["9", { ...timeline, apiId: "9", parentMissing: true, proceeding: null }],
    ]),
    1,
  )[0]!;
  let calls = 0;
  for (const language of ["en", "de"] as const) {
    const brief = await generateProceedingBrief(
      prisma,
      { question: "What rules apply?", language, dossier: orphan },
      fixtureProvider(async () => {
        calls += 1;
        return answer(language);
      }),
    );
    assert.equal(brief.answerConfidence, "abstain");
    assert.deepEqual(Object.values(brief.claims).flat(), []);
    assert.match(brief.qualification ?? "", /missing|fehlt/u);
    assert.equal(brief.proceedingApiId, "9");
  }
  assert.equal(calls, 0);
});

test("a broad question can cite a linked PDF added after proceeding selection", async () => {
  const { prisma } = store();
  const withoutPage = {
    ...dossier,
    evidence: dossier.evidence.filter((item) => item.entity !== "dokument"),
  };
  const enriched = addDocumentEvidence([withoutPage], [hit])[0]!;
  const brief = await generateProceedingBrief(
    prisma,
    {
      question: "What happened to housing?",
      language: "en",
      dossier: enriched,
    },
    fixtureProvider(async ({ evidence }) => {
      assert.ok(evidence.some((item) => item.id === "page:3:2"));
      return answer("en");
    }),
  );
  assert.equal(brief.claims.documents[0]?.citation.referenceId, "3");
});

test("unsupported citations are dropped while documented steps remain", async () => {
  const { prisma, setVariant } = store();
  const unsupported = await validateAnswer(
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
    "en",
    approveFixtureClaims,
  );
  assert.deepEqual(unsupported.documents, []);
  setVariant(2, "hash-two");
  const brief = await generateProceedingBrief(
    prisma,
    {
      question: "What does the document say?",
      language: "en",
      dossier: dossier,
    },
    fixtureProvider(async () => ({
      matter: [],
      stage: [],
      steps: [],
      documents: [],
      unresolved: [],
    })),
  );
  assert.equal(brief.answerConfidence, "partial");
  assert.deepEqual(brief.claims.documents, []);
  assert.equal(brief.claims.steps[0]?.citation.stepId, "2");
  assert.match(brief.qualification!, /does not establish/);
});

test("an unsupported or absent lead answer leaves the brief without a lead claim", async () => {
  const { prisma } = store();
  const invented = await generateProceedingBrief(
    prisma,
    { question: "What happened?", language: "en", dossier: dossier },
    fixtureProvider(async () => ({
      ...answer("en"),
      answer: [
        {
          text: "The bill has become law.",
          evidenceId: "step:2",
          quote: "not in the step",
        },
      ],
    })),
  );
  assert.deepEqual(invented.claims.answer, []);
  assert.equal(invented.claims.matter.length, 1);
  const absent = await generateProceedingBrief(
    prisma,
    { question: "What is this about?", language: "en", dossier: dossier },
    fixtureProvider(async () => ({ ...answer("en"), answer: [] })),
  );
  assert.deepEqual(absent.claims.answer, []);
  assert.equal(absent.claims.matter.length, 1);
});

test("selected lead claims use only supplied ids and copy the claim", () => {
  const stage = {
    text: "It reached a first reading.",
    quote: "First reading",
    citation: {
      kind: "step" as const,
      stepId: "2",
      url: "https://example.org/step/2",
    },
  };
  const matter = { ...stage, text: "The bill concerns housing grants." };
  const candidates = [
    { id: "matter:0", claim: matter },
    { id: "stage:0", claim: stage },
  ];
  assert.deepEqual(
    selectedAnswerClaims(candidates, {
      claimIds: ["stage:0", "invented", "stage:0", "matter:0"],
    }),
    [stage, matter],
  );
  assert.deepEqual(selectedAnswerClaims(candidates, { claimIds: [] }), []);
});

test("an empty lead is filled from this language's verified claims", async () => {
  const { prisma } = store();
  const selected: string[][] = [];
  const brief = await generateProceedingBrief(
    prisma,
    { question: "Was ist der Stand?", language: "de", dossier: dossier },
    {
      generate: async () => ({ answer: [], stage: [] }),
      verify: approveFixtureClaims,
      translate: async () => ({ claims: [] }),
      translateTerms: async ({ terms }) => ({ terms }),
      selectAnswer: async ({ claims }) => {
        selected.push(claims.map(({ id }) => id));
        return { claimIds: ["stage:0"] };
      },
      identity: "fixture",
    },
  );
  assert.equal(selected.length, 1);
  assert.ok(selected[0]?.includes("stage:0"));
  assert.equal(brief.claims.answer.length, 1);
  assert.match(
    brief.claims.answer[0]?.text ?? "",
    /Letzter dokumentierter Schritt/u,
  );
  assert.equal(brief.claims.answer[0]?.citation.stepId, "2");
});

test("a generated lead is not replaced by claim selection", async () => {
  const { prisma } = store();
  let calls = 0;
  const brief = await generateProceedingBrief(
    prisma,
    { question: "What happened?", language: "en", dossier: dossier },
    {
      generate: async () => answer("en"),
      verify: approveFixtureClaims,
      translate: async () => ({ claims: [] }),
      translateTerms: async ({ terms }) => ({ terms }),
      selectAnswer: async () => {
        calls += 1;
        return { claimIds: ["stage:0"] };
      },
      identity: "fixture",
    },
  );
  assert.equal(calls, 0);
  assert.equal(
    brief.claims.answer[0]?.text,
    "The bill is at its first reading.",
  );
});

test("a proceeding with no step or page evidence abstains", async () => {
  const { prisma } = store(true);
  const noEvidence = buildDossiers(
    [
      {
        entity: "vorgang",
        apiId: "1",
        proceedingApiId: "1",
        versionNo: 1,
        score: 0.8,
        title: "Housing bill",
        summary: null,
        stepLabel: null,
        source: {
          endpoint: "/vorgang",
          apiId: "1",
          url: "https://example.org/proceeding/1",
        },
      } as DipHit,
    ],
    new Map([["1", { ...timeline, steps: [] }]]),
    1,
  )[0]!;
  const brief = await generateProceedingBrief(
    prisma,
    { question: "What happened?", language: "en", dossier: noEvidence },
    fixtureProvider(async () => {
      throw new Error("No evidence should reach the model");
    }),
  );
  assert.equal(brief.answerConfidence, "abstain");
  assert.deepEqual(brief.claims.steps, []);
});

test("a relevant dossier that lacks the requested fact qualifies and names it", async () => {
  const { prisma } = store();
  for (const language of ["en", "de"] as const) {
    const brief = await generateProceedingBrief(
      prisma,
      {
        question:
          language === "en"
            ? "How much did the Autobahn GmbH receive from the truck toll in 2025?"
            : "Wie hoch waren die Einnahmen der Autobahn GmbH aus der Lkw-Maut im Jahr 2025?",
        language,
        dossier,
      },
      fixtureProvider(async () => ({
        ...answer(language),
        missing: [
          language === "en"
            ? "the 2025 truck-toll revenue"
            : "die Lkw-Mauteinnahmen im Jahr 2025",
        ],
      })),
    );
    assert.equal(brief.answerConfidence, "partial");
    assert.match(brief.qualification!, /2025/u);
    assert.equal(brief.claims.documents.length, 1);
  }
});

test("PDF line wrapping does not discard an otherwise exact cited quote", async () => {
  const original =
    "Der Gesetzentwurf ist besonders eilbedürftig, um eine\n  gemeinsame Beratung im parlamentarischen Verfahren zu ermöglichen.";
  const result = await validateAnswer(
    {
      ...answer("de"),
      documents: [
        {
          text: "Der Entwurf ist eilbedürftig.",
          evidenceId: "page:3:2",
          quote:
            "Der Gesetzentwurf ist besonders eilbedürftig, um eine gemeinsame Beratung im parlamentarischen Verfahren zu ermöglichen.",
        },
      ],
    },
    [
      {
        id: "page:3:2",
        text: original,
        citation: {
          kind: "page",
          stepId: "2",
          referenceId: "3",
          page: 2,
          url: pdfUrl,
        },
      },
    ],
    "de",
    approveFixtureClaims,
  );
  assert.equal(result.documents[0]?.quote, original);
  assert.equal(result.documents[0]?.citation.referenceId, "3");
});

test("malformed document claims do not discard valid ordered steps", async () => {
  const { prisma } = store();
  const brief = await generateProceedingBrief(
    prisma,
    { question: "What happened?", language: "de", dossier: dossier },
    fixtureProvider(async () => ({
      ...answer("de"),
      documents: [
        {
          evidenceId: "page:3:2",
          quote: "The bill would provide housing grants.",
        },
        answer("de").documents[0],
      ],
    })),
  );
  assert.equal(
    brief.claims.steps[0]?.text,
    "Die erste Lesung ist dokumentiert.",
  );
  assert.equal(brief.claims.documents.length, 1);
});

test("stored steps fill an omitted model timeline with source citations", async () => {
  const { prisma } = store();
  const brief = await generateProceedingBrief(
    prisma,
    { question: "What happened?", language: "de", dossier: dossier },
    fixtureProvider(async () => ({ ...answer("de"), steps: [] })),
  );
  assert.match(
    brief.claims.steps[0]?.text ?? "",
    /Ein Verfahrensschritt ist dokumentiert/,
  );
  assert.equal(brief.claims.steps[0]?.citation.stepId, "2");
  assert.match(brief.claims.steps[0]?.quote ?? "", /First reading/);
});

test("extra model claims retain all cited steps without rejecting the answer", async () => {
  const claims = Array.from({ length: 12 }, (_, index) => ({
    text: `Recorded step ${index}`,
    evidenceId: "step:2",
    quote: index === 0 ? "Unsupported quote" : "First reading",
  }));
  const result = await validateAnswer(
    { ...answer("en"), steps: claims },
    [
      {
        id: "step:2",
        text: "First reading | Housing bill introduced",
        citation: {
          kind: "step",
          stepId: "2",
          url: "https://example.org/step/2",
        },
      },
    ],
    "en",
    approveFixtureClaims,
  );
  assert.equal(result.steps.length, 11);
  assert.equal(result.steps[0]?.text, "Recorded step 1");
  assert.equal(result.steps[10]?.text, "Recorded step 11");
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
    {
      question: "What does the document say?",
      language: "de",
      dossier: ineligible,
    },
    fixtureProvider(async () => answer("de")),
  );
  assert.deepEqual(brief.claims.documents, []);
  assert.equal(brief.answerConfidence, "partial");
});

test("a stale revision cannot be cited, and a reverted variant can again", async () => {
  const { prisma, setVariant, setRequestedUrl } = store();
  const current = await generateProceedingBrief(
    prisma,
    { question: "What does it say?", language: "en", dossier: dossier },
    fixtureProvider(async () => answer("en")),
  );
  assert.equal(current.claims.documents[0]?.citation.referenceId, "3");

  // The reference moved to a revision that has not been processed.
  setRequestedUrl(`${pdfUrl}?revised`);
  const stale = await generateProceedingBrief(
    prisma,
    {
      question: "What does the stale revision say?",
      language: "en",
      dossier: dossier,
    },
    fixtureProvider(async () => answer("en")),
  );
  assert.deepEqual(stale.claims.documents, []);

  // Reverting to the cited variant makes the same hit citable again.
  setRequestedUrl(pdfUrl);
  const reverted = await generateProceedingBrief(
    prisma,
    {
      question: "What does the reverted document say?",
      language: "en",
      dossier: dossier,
    },
    fixtureProvider(async () => answer("en")),
  );
  assert.equal(reverted.claims.documents[0]?.citation.referenceId, "3");

  // A superseded variant is no longer the cited one, even at the same url.
  setVariant(2, "hash-two");
  const superseded = await generateProceedingBrief(
    prisma,
    {
      question: "What does the superseded variant say?",
      language: "en",
      dossier: dossier,
    },
    fixtureProvider(async () => answer("en")),
  );
  assert.deepEqual(superseded.claims.documents, []);
});

test("cached briefs regenerate for each language and changed PDF evidence", async () => {
  const { prisma, briefs, setVariant } = store();
  let calls = 0;
  const generate = async () => {
    calls++;
    return answer("en");
  };
  await generateProceedingBrief(
    prisma,
    { question: "Question", language: "en", dossier: dossier },
    fixtureProvider(generate),
  );
  await generateProceedingBrief(
    prisma,
    { question: "Question", language: "en", dossier: dossier },
    fixtureProvider(generate),
  );
  assert.equal(calls, 1);
  await generateProceedingBrief(
    prisma,
    { question: "Question", language: "de", dossier: dossier },
    fixtureProvider(generate),
  );
  assert.equal(calls, 2);
  setVariant(2, "hash-two");
  await generateProceedingBrief(
    prisma,
    { question: "Question", language: "en", dossier: dossier },
    fixtureProvider(generate),
  );
  assert.equal(calls, 3);
  assert.equal(briefs.size, 3);
});

test("a cache hit returns before reading pages and chunks", async () => {
  const { prisma, reads } = store();
  let generated = 0;
  const provider = fixtureProvider(async () => {
    generated++;
    return answer("en");
  });
  const request = { question: "Question", language: "en" as const, dossier };
  const first = await generateProceedingBrief(prisma, request, provider);
  assert.equal(generated, 1);
  assert.equal(reads.variants, 1);
  assert.ok(reads.chunks > 0);
  assert.ok(reads.pages > 0);

  const chunks = reads.chunks;
  const pages = reads.pages;
  assert.deepEqual(
    await generateProceedingBrief(prisma, request, provider),
    first,
  );
  assert.equal(generated, 1);
  assert.equal(reads.variants, 2);
  assert.equal(reads.chunks, chunks);
  assert.equal(reads.pages, pages);
});

test("a brief cached before source views does not keep its old citation links", async () => {
  const { prisma, briefs } = store();
  const oldKey = createHash("sha256")
    .update(
      JSON.stringify([
        16,
        "Question",
        "en",
        "fixture",
        "1",
        1,
        [["2", 1, "3", pdfUrl]],
        [["3", "hash-one", pdfUrl]],
        [
          ["step:2", stepSource(timeline.steps[0]!)],
          [
            "page:3:2",
            "The bill would provide housing grants. It also funds demolition.",
          ],
        ],
      ]),
    )
    .digest("hex");
  briefs.set(oldKey, {
    claims: {
      answer: [{ citation: { url: "https://example.org/step/2" } }],
    },
  });
  let calls = 0;
  const brief = await generateProceedingBrief(
    prisma,
    { question: "Question", language: "en", dossier },
    fixtureProvider(async () => {
      calls++;
      return answer("en");
    }),
  );
  assert.equal(calls, 1);
  assert.equal(brief.claims.answer[0]?.citation.url, "/source/step/2");
  assert.equal(briefs.size, 2);
});

test("a cached brief is reused only under the same adapter identity", async () => {
  const { prisma, briefs } = store();
  let calls = 0;
  const generate = async () => {
    calls++;
    return answer("en");
  };
  const request = { question: "Question", language: "en" as const, dossier };
  const first = await generateProceedingBrief(
    prisma,
    request,
    fixtureProvider(generate, undefined, "shared"),
  );
  assert.deepEqual(
    await generateProceedingBrief(
      prisma,
      request,
      fixtureProvider(
        async () => {
          throw new Error("cache miss");
        },
        undefined,
        "shared",
      ),
    ),
    first,
  );
  assert.equal(calls, 1);
  await generateProceedingBrief(
    prisma,
    request,
    fixtureProvider(generate, undefined, "other"),
  );
  assert.equal(calls, 2);
  assert.equal(briefs.size, 2);
});

test("the live adapter identity tracks the configured model", () => {
  const previousModel = process.env.EXPLAIN_MODEL;
  try {
    process.env.EXPLAIN_MODEL = "model-one";
    const first = chatCompletionsProvider().identity;
    process.env.EXPLAIN_MODEL = "model-two";
    assert.notEqual(chatCompletionsProvider().identity, first);
  } finally {
    if (previousModel === undefined) delete process.env.EXPLAIN_MODEL;
    else process.env.EXPLAIN_MODEL = previousModel;
  }
});

test("a changed proceeding version rejects a stale dossier", async () => {
  const { prisma, setVersion, briefs } = store();
  let calls = 0;
  const generate = async () => {
    calls++;
    return answer("en");
  };
  await generateProceedingBrief(
    prisma,
    { question: "Question", language: "en", dossier: dossier },
    fixtureProvider(generate),
  );
  setVersion(2);
  await assert.rejects(
    generateProceedingBrief(
      prisma,
      { question: "Question", language: "en", dossier: dossier },
      fixtureProvider(generate),
    ),
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
  await generateProceedingBrief(
    prisma,
    { question: "Question", language: "en", dossier: updated },
    fixtureProvider(generate),
  );
  assert.equal(calls, 2);
  assert.equal(briefs.size, 2);
});

test("English fallback uses a localized statement and retains the German source quote", async () => {
  const { prisma } = store(false, "Beschlussempfehlung und Bericht");
  const brief = await generateProceedingBrief(
    prisma,
    { question: "What happened?", language: "en", dossier: dossier },
    fixtureProvider(async () => ({ steps: [] })),
  );
  assert.equal(
    brief.claims.steps[0]?.text,
    "10 Oct 2026 · A proceeding step is documented.",
  );
  assert.match(
    brief.claims.steps[0]?.quote ?? "",
    /Beschlussempfehlung und Bericht/,
  );
});

test("the current stage falls back to the latest step when the model omits it", async () => {
  const { prisma } = store();
  const brief = await generateProceedingBrief(
    prisma,
    { question: "Was ist der Stand?", language: "de", dossier: dossier },
    fixtureProvider(async () => ({ stage: [] })),
  );
  assert.equal(
    brief.claims.stage[0]?.text,
    "10.10.2026 · Letzter dokumentierter Schritt: First reading",
  );
  assert.equal(brief.claims.stage[0]?.citation.stepId, "2");
});

test("the matter falls back to the earliest titled step when the model omits it", async () => {
  const { prisma } = store();
  for (const language of ["en", "de"] as const) {
    const brief = await generateProceedingBrief(
      prisma,
      { question: "What is this about?", language, dossier: dossier },
      fixtureProvider(async () => ({})),
    );
    assert.equal(brief.claims.matter.length, 1);
    assert.match(
      brief.claims.matter[0]?.text ?? "",
      /Housing bill introduced/u,
    );
    assert.equal(brief.claims.matter[0]?.citation.stepId, "2");
  }
});

test("English fallbacks translate the German title and label, not copy them", async () => {
  const { prisma } = store(
    false,
    "Schriftliche Frage/Schriftliche Antwort",
    "Ausgaben für das Museum",
  );
  const translations: Record<string, string> = {
    "Ausgaben für das Museum": "Museum spending",
    "Schriftliche Frage/Schriftliche Antwort":
      "Written question/Written answer",
  };
  let termCalls = 0;
  const brief = await generateProceedingBrief(
    prisma,
    { question: "What happened?", language: "en", dossier: dossier },
    fixtureProvider(
      async () => ({}),
      async () => ({ claims: [] }),
      "fixture",
      async ({ terms }) => {
        termCalls++;
        return {
          terms: terms.map(({ id, text }) => ({
            id,
            text: translations[text] ?? text,
          })),
        };
      },
    ),
  );
  assert.equal(termCalls, 1);
  assert.equal(
    brief.claims.matter[0]?.text,
    "The proceeding concerns Museum spending.",
  );
  assert.equal(
    brief.claims.stage[0]?.text,
    "10 Oct 2026 · Latest documented step: Written question/Written answer",
  );
  assert.doesNotMatch(brief.claims.matter[0]?.text ?? "", /Ausgaben/u);
  assert.doesNotMatch(brief.claims.stage[0]?.text ?? "", /Schriftliche Frage/u);
  // The quote stays German: it is the auditable source passage.
  assert.match(
    brief.claims.stage[0]?.quote ?? "",
    /Schriftliche Frage\/Schriftliche Antwort/u,
  );
});

test("one page keeps every verified claim and only unclaimed pages are translated", async () => {
  const citation = (referenceId: string, page: number) => ({
    kind: "page" as const,
    stepId: "2",
    referenceId,
    page,
    url: pdfUrl,
  });
  const translated: string[] = [];
  const claims = await alignDocumentClaims(
    [
      {
        id: "page:3:2",
        text: "First fact. Second fact.",
        citation: citation("3", 2),
      },
      { id: "page:4:1", text: "Third fact.", citation: citation("4", 1) },
    ],
    [
      {
        text: "The first fact holds.",
        quote: "First fact.",
        citation: citation("3", 2),
      },
      {
        text: "The second fact also holds.",
        quote: "Second fact.",
        citation: citation("3", 2),
      },
    ],
    "en",
    async ({ pages }) => {
      translated.push(...pages.map((page) => page.id));
      return { claims: [{ id: "page:4:1", text: "The third fact holds." }] };
    },
  );
  assert.deepEqual(translated, ["page:4:1"]);
  assert.deepEqual(
    claims.map((claim) => claim.text),
    [
      "The first fact holds.",
      "The second fact also holds.",
      "The third fact holds.",
    ],
  );
  assert.deepEqual(claims[1]?.citation, citation("3", 2));
});

test("an unsupported second claim from a cited page is dropped, not translated back", async () => {
  const { prisma } = store();
  let translations = 0;
  const brief = await generateProceedingBrief(
    prisma,
    { question: "What does it say?", language: "en", dossier: dossier },
    {
      generate: async () => ({
        ...answer("en"),
        documents: [
          {
            text: "The document proposes housing grants.",
            evidenceId: "page:3:2",
            quote: "The bill would provide housing grants.",
          },
          {
            text: "The bill also funds demolition.",
            evidenceId: "page:3:2",
            quote: "housing grants",
          },
        ],
      }),
      verify: async ({ claims }) => ({
        supportedClaimIds: claims
          .filter((claim) => !claim.text.includes("demolition"))
          .map(({ id }) => id),
      }),
      translate: async () => {
        translations++;
        return { claims: [] };
      },
      translateTerms: async ({ terms }) => ({ terms }),
      identity: "fixture",
    },
  );
  assert.equal(translations, 0);
  assert.deepEqual(
    brief.claims.documents.map((claim) => claim.text),
    ["The document proposes housing grants."],
  );
});

test("a cited page exposes every passage on it, not only the retrieved chunk", async () => {
  const { prisma } = store();
  const brief = await generateProceedingBrief(
    prisma,
    { question: "What does it cover?", language: "en", dossier: dossier },
    fixtureProvider(async ({ evidence }) => {
      const page = evidence.find((item) => item.id === "page:3:2");
      assert.match(page?.text ?? "", /also funds demolition/u);
      return {
        ...answer("en"),
        documents: [
          {
            text: "The bill also funds demolition.",
            evidenceId: "page:3:2",
            quote: "It also funds demolition.",
          },
        ],
      };
    }),
  );
  assert.equal(
    brief.claims.documents[0]?.text,
    "The bill also funds demolition.",
  );
});

test("two retrieved chunks of one page become a single page evidence item", async () => {
  const { prisma } = store();
  const twice = buildDossiers(
    [hit, { ...hit, chunk: 2, score: 0.7 } as DipHit],
    new Map([["1", timeline]]),
    1,
  )[0]!;
  let pageIds: string[] = [];
  await generateProceedingBrief(
    prisma,
    { question: "What does it cover?", language: "en", dossier: twice },
    fixtureProvider(async ({ evidence }) => {
      pageIds = evidence
        .filter((item) => item.citation.kind === "page")
        .map((item) => item.id);
      return answer("en");
    }),
  );
  assert.deepEqual(pageIds, ["page:3:2"]);
});

test("both briefs cite the same retrieved page when the model omits it", async () => {
  const { prisma } = store();
  const translations = {
    en: "The bill would provide housing grants.",
    de: "Das Gesetz würde Wohnbeihilfen vorsehen.",
  };
  for (const language of ["en", "de"] as const) {
    const brief = await generateProceedingBrief(
      prisma,
      { question: "What does it say?", language: language, dossier: dossier },
      fixtureProvider(
        async () => ({}),
        async () => ({
          claims: [{ id: "page:3:2", text: translations[language] }],
        }),
      ),
    );
    assert.deepEqual(
      brief.claims.documents.map((claim) => claim.citation),
      [
        {
          kind: "page",
          stepId: "2",
          referenceId: "3",
          page: 2,
          url: "/source/document/3?page=2&step=2",
          pdfUrl: `${pdfUrl}#page=2`,
        },
      ],
    );
    assert.equal(brief.claims.documents[0]?.text, translations[language]);
  }
});

test("an English claim that repeats the German passage is replaced by a translation", async () => {
  const { prisma } = store();
  const brief = await generateProceedingBrief(
    prisma,
    { question: "What does it say?", language: "en", dossier: dossier },
    fixtureProvider(
      async () => ({
        ...answer("en"),
        documents: [
          {
            text: "The bill would provide housing grants.",
            evidenceId: "page:3:2",
            quote: "The bill would provide housing grants.",
          },
        ],
      }),
      async () => ({
        claims: [
          {
            id: "page:3:2",
            text: "The bill provides housing grants.",
          },
        ],
      }),
    ),
  );
  assert.equal(
    brief.claims.documents[0]?.text,
    "The bill provides housing grants.",
  );
});

test("verification drops and never caches an invented status paired with a valid quote", async () => {
  const { prisma, briefs } = store();
  let checks = 0;
  const brief = await generateProceedingBrief(
    prisma,
    { question: "What happened?", language: "en", dossier: dossier },
    {
      generate: async () => ({
        ...answer("en"),
        stage: [
          {
            text: "The bill has become law.",
            evidenceId: "step:2",
            quote: "First reading",
          },
        ],
      }),
      verify: async ({ claims, evidence, language }) => {
        checks++;
        assert.equal(language, "en");
        assert.ok(evidence.some((item) => item.text.includes("First reading")));
        assert.equal(
          claims.find((claim) => claim.section === "stage")?.text,
          "The bill has become law.",
        );
        return {
          supportedClaimIds: claims
            .filter((claim) => claim.section !== "stage")
            .map((claim) => claim.id),
        };
      },
      translate: async () => ({ claims: [] }),
      translateTerms: async ({ terms }) => ({ terms }),
      identity: "fixture",
    },
  );
  assert.equal(checks, 1);
  assert.equal(
    brief.claims.stage[0]?.text,
    "10 Oct 2026 · Latest documented step: First reading",
  );
  assert.equal(brief.claims.documents.length, 1);
  assert.equal(brief.answerConfidence, "partial");
  assert.doesNotMatch(JSON.stringify([...briefs.values()]), /has become law/);
});

test("verification failures and malformed verdicts cannot cache an unverified brief", async () => {
  for (const verdict of [
    null,
    {},
    { supportedClaimIds: [999] },
    { supportedClaimIds: ["0"] },
  ]) {
    const { prisma, briefs } = store();
    await assert.rejects(
      generateProceedingBrief(
        prisma,
        { question: "Question", language: "en", dossier: dossier },
        {
          generate: async () => answer("en"),
          verify: async () => verdict,
          translate: async () => ({ claims: [] }),
          translateTerms: async ({ terms }) => ({ terms }),
          identity: "fixture",
        },
      ),
    );
    assert.equal(briefs.size, 0);
  }
  const { prisma, briefs } = store();
  await assert.rejects(
    generateProceedingBrief(
      prisma,
      { question: "Question", language: "en", dossier: dossier },
      {
        generate: async () => answer("en"),
        verify: async () => {
          throw new Error("Verifier unavailable");
        },
        translate: async () => ({ claims: [] }),
        translateTerms: async ({ terms }) => ({ terms }),
        identity: "fixture",
      },
    ),
    /Verifier unavailable/,
  );
  assert.equal(briefs.size, 0);
});

test("a bare step id from the model resolves to the stored step evidence", async () => {
  const result = await validateAnswer(
    {
      answer: [
        {
          text: "The bill is at its first reading.",
          evidenceId: "2",
          quote: "First reading",
        },
      ],
    },
    [
      {
        id: "step:2",
        text: "First reading | Housing bill introduced",
        citation: {
          kind: "step",
          stepId: "2",
          url: "https://example.org/step/2",
        },
      },
    ],
    "en",
    approveFixtureClaims,
  );
  assert.equal(result.answer[0]?.citation.stepId, "2");
});

test("missing facts accept both plain strings and claim-shaped objects", () => {
  assert.deepEqual(
    missingFacts({
      missing: [
        "the 2025 truck-toll revenue",
        { text: "the 2026 target", evidenceId: null, quote: null },
      ],
    }),
    ["the 2025 truck-toll revenue", "the 2026 target"],
  );
  assert.deepEqual(missingFacts({ missing: [] }), []);
});

test("page citations cannot substitute for procedural step evidence", async () => {
  const result = await validateAnswer(
    { steps: [{ ...answer("en").documents[0] }] },
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
    "en",
    async () => {
      throw new Error("Invalid citations must not reach verification");
    },
  );
  assert.deepEqual(result.steps, []);
});

test("the provider path verifies generated claims and reuses only the verified cache", async (t) => {
  const previousModel = process.env.EXPLAIN_MODEL;
  const previousUrl = process.env.EXPLAIN_BASE_URL;
  process.env.EXPLAIN_MODEL = "fixture-model";
  process.env.EXPLAIN_BASE_URL = "http://localhost:11434/v1";
  let requests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      requests++;
      const request = JSON.parse(String(init?.body));
      const input = JSON.parse(request.messages[1].content);
      let content: unknown;
      if (requests === 1) {
        assert.equal(input.language, "en");
        content = {
          ...answer("en"),
          stage: [
            {
              text: "The bill has become law.",
              evidenceId: "step:2",
              quote: "First reading",
            },
          ],
        };
      } else if (requests === 2) {
        assert.match(
          request.messages[0].content,
          /An exact quote alone does not establish/,
        );
        assert.equal(input.claims[2].text, "The bill has become law.");
        assert.equal(input.claims[2].quote, "First reading");
        assert.ok(
          input.evidence.some((item: { id: string }) => item.id === "step:2"),
        );
        content = { supportedClaimIds: [0, 1, 3, 4] };
      } else {
        assert.equal(requests, 3);
        assert.match(
          request.messages[0].content,
          /German parliamentary title or step label/,
        );
        content = {
          terms: input.terms.map(
            ({ id, text }: { id: string; text: string }) => ({
              id,
              text,
            }),
          ),
        };
      }
      return Response.json({
        choices: [{ message: { content: JSON.stringify(content) } }],
      });
    },
  );
  try {
    const { prisma } = store();
    const brief = await generateProceedingBrief(prisma, {
      question: "Question",
      language: "en",
      dossier: dossier,
    });
    assert.equal(
      brief.claims.stage[0]?.text,
      "10 Oct 2026 · Latest documented step: First reading",
    );
    assert.equal(brief.claims.documents.length, 1);
    assert.deepEqual(
      await generateProceedingBrief(prisma, {
        question: "Question",
        language: "en",
        dossier: dossier,
      }),
      brief,
    );
    assert.deepEqual(
      await generateProceedingBrief(
        prisma,
        { question: "Question", language: "en", dossier: dossier },
        {
          generate: async () => {
            throw new Error("cache miss");
          },
          verify: approveFixtureClaims,
          translate: async () => ({ claims: [] }),
          translateTerms: async ({ terms }) => ({ terms }),
          identity: chatCompletionsProvider().identity,
        },
      ),
      brief,
    );
    assert.equal(requests, 3);
  } finally {
    if (previousModel === undefined) delete process.env.EXPLAIN_MODEL;
    else process.env.EXPLAIN_MODEL = previousModel;
    if (previousUrl === undefined) delete process.env.EXPLAIN_BASE_URL;
    else process.env.EXPLAIN_BASE_URL = previousUrl;
  }
});
