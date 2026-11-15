import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { addDocumentEvidence, buildDossiers } from "../src/dip/dossiers.js";
import { generateProceedingBrief, validateAnswer } from "../src/dip/explain.js";
import type { ProceedingTimeline } from "../src/dip/proceeding.js";
import type { DipHit } from "../src/dip/search.js";

const approveFixtureClaims: NonNullable<
  Parameters<typeof generateProceedingBrief>[5]
> = async ({ claims }) => ({
  supportedClaimIds: claims.map(({ id }) => id),
});

function generateTestBrief(
  prisma: PrismaClient,
  question: string,
  language: "en" | "de",
  dossier: Parameters<typeof generateProceedingBrief>[3],
  generate: NonNullable<Parameters<typeof generateProceedingBrief>[4]>,
  translate: NonNullable<
    Parameters<typeof generateProceedingBrief>[6]
  > = async () => ({ claims: [] }),
) {
  return generateProceedingBrief(
    prisma,
    question,
    language,
    dossier,
    generate,
    approveFixtureClaims,
    translate,
  );
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

function store(noSteps = false, stepLabel = "First reading") {
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
      findMany: async () =>
        noSteps
          ? []
          : [
              {
                apiId: "2",
                institution: "BT",
                stepLabel,
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
    const brief = await generateTestBrief(
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

test("a broad question can cite a linked PDF added after proceeding selection", async () => {
  const { prisma } = store();
  const withoutPage = {
    ...dossier,
    evidence: dossier.evidence.filter((item) => item.entity !== "dokument"),
  };
  const enriched = addDocumentEvidence([withoutPage], [hit])[0]!;
  const brief = await generateTestBrief(
    prisma,
    "What happened to housing?",
    "en",
    enriched,
    async ({ evidence }) => {
      assert.ok(evidence.some((item) => item.id === "page:3:2"));
      return answer("en");
    },
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
  const brief = await generateTestBrief(
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
  assert.equal(brief.answerConfidence, "partial");
  assert.deepEqual(brief.claims.documents, []);
  assert.equal(brief.claims.steps[0]?.citation.stepId, "2");
  assert.match(brief.qualification!, /does not establish/);
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
  const brief = await generateTestBrief(
    prisma,
    "What happened?",
    "en",
    noEvidence,
    async () => {
      throw new Error("No evidence should reach the model");
    },
  );
  assert.equal(brief.answerConfidence, "abstain");
  assert.deepEqual(brief.claims.steps, []);
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
  const brief = await generateTestBrief(
    prisma,
    "What happened?",
    "de",
    dossier,
    async () => ({
      ...answer("de"),
      documents: [
        {
          evidenceId: "page:3:2",
          quote: "The bill would provide housing grants.",
        },
        answer("de").documents[0],
      ],
    }),
  );
  assert.equal(
    brief.claims.steps[0]?.text,
    "Die erste Lesung ist dokumentiert.",
  );
  assert.equal(brief.claims.documents.length, 1);
});

test("stored steps fill an omitted model timeline with source citations", async () => {
  const { prisma } = store();
  const brief = await generateTestBrief(
    prisma,
    "What happened?",
    "de",
    dossier,
    async () => ({ ...answer("de"), steps: [] }),
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
  const brief = await generateTestBrief(
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
  await generateTestBrief(prisma, "Question", "en", dossier, generate);
  await generateTestBrief(prisma, "Question", "en", dossier, generate);
  assert.equal(calls, 1);
  await generateTestBrief(prisma, "Question", "de", dossier, generate);
  assert.equal(calls, 2);
  setVariant(2, "hash-two");
  await generateTestBrief(prisma, "Question", "en", dossier, generate);
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
  await generateTestBrief(prisma, "Question", "en", dossier, generate);
  setVersion(2);
  await assert.rejects(
    generateTestBrief(prisma, "Question", "en", dossier, generate),
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
  await generateTestBrief(prisma, "Question", "en", updated, generate);
  assert.equal(calls, 2);
  assert.equal(briefs.size, 2);
});

test("English fallback uses a localized statement and retains the German source quote", async () => {
  const { prisma } = store(false, "Beschlussempfehlung und Bericht");
  const brief = await generateTestBrief(
    prisma,
    "What happened?",
    "en",
    dossier,
    async () => ({ steps: [] }),
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
  const brief = await generateTestBrief(
    prisma,
    "Was ist der Stand?",
    "de",
    dossier,
    async () => ({ stage: [] }),
  );
  assert.equal(
    brief.claims.stage[0]?.text,
    "10.10.2026 · Letzter dokumentierter Schritt: First reading",
  );
  assert.equal(brief.claims.stage[0]?.citation.stepId, "2");
});

test("both briefs cite the same retrieved page when the model omits it", async () => {
  const { prisma } = store();
  const translations = {
    en: "The bill would provide housing grants.",
    de: "Das Gesetz würde Wohnbeihilfen vorsehen.",
  };
  for (const language of ["en", "de"] as const) {
    const brief = await generateTestBrief(
      prisma,
      "What does it say?",
      language,
      dossier,
      async () => ({}),
      async () => ({
        claims: [{ id: "page:3:2", text: translations[language] }],
      }),
    );
    assert.deepEqual(
      brief.claims.documents.map((claim) => claim.citation),
      [{ kind: "page", stepId: "2", referenceId: "3", page: 2, url: pdfUrl }],
    );
    assert.equal(brief.claims.documents[0]?.text, translations[language]);
  }
});

test("an English claim that repeats the German passage is replaced by a translation", async () => {
  const { prisma } = store();
  const brief = await generateTestBrief(
    prisma,
    "What does it say?",
    "en",
    dossier,
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
    "What happened?",
    "en",
    dossier,
    async () => ({
      ...answer("en"),
      stage: [
        {
          text: "The bill has become law.",
          evidenceId: "step:2",
          quote: "First reading",
        },
      ],
    }),
    async ({ claims, evidence, language }) => {
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
        "Question",
        "en",
        dossier,
        async () => answer("en"),
        async () => verdict,
      ),
    );
    assert.equal(briefs.size, 0);
  }
  const { prisma, briefs } = store();
  await assert.rejects(
    generateProceedingBrief(
      prisma,
      "Question",
      "en",
      dossier,
      async () => answer("en"),
      async () => {
        throw new Error("Verifier unavailable");
      },
    ),
    /Verifier unavailable/,
  );
  assert.equal(briefs.size, 0);
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
      } else {
        assert.equal(requests, 2);
        assert.match(
          request.messages[0].content,
          /An exact quote alone does not establish/,
        );
        assert.equal(input.claims[1].text, "The bill has become law.");
        assert.equal(input.claims[1].quote, "First reading");
        assert.ok(
          input.evidence.some((item: { id: string }) => item.id === "step:2"),
        );
        content = { supportedClaimIds: [0, 2, 3] };
      }
      return Response.json({
        choices: [{ message: { content: JSON.stringify(content) } }],
      });
    },
  );
  try {
    const { prisma } = store();
    const brief = await generateProceedingBrief(
      prisma,
      "Question",
      "en",
      dossier,
    );
    assert.equal(
      brief.claims.stage[0]?.text,
      "10 Oct 2026 · Latest documented step: First reading",
    );
    assert.equal(brief.claims.documents.length, 1);
    assert.deepEqual(
      await generateProceedingBrief(prisma, "Question", "en", dossier),
      brief,
    );
    assert.equal(requests, 2);
  } finally {
    if (previousModel === undefined) delete process.env.EXPLAIN_MODEL;
    else process.env.EXPLAIN_MODEL = previousModel;
    if (previousUrl === undefined) delete process.env.EXPLAIN_BASE_URL;
    else process.env.EXPLAIN_BASE_URL = previousUrl;
  }
});
