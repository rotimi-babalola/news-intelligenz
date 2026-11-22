import assert from "node:assert/strict";
import { test } from "node:test";
import {
  meanScore,
  scoreAnswer,
  type AnswerLabel,
} from "../src/dip/explain/evaluate.js";

const label: AnswerLabel = {
  question: "What does the document say?",
  language: "en",
  expectAbstain: false,
  facts: [
    {
      text: "The bill provides housing grants.",
      terms: ["housing grants"],
      evidenceIds: ["page:3:2"],
      quote: "The bill would provide housing grants.",
    },
  ],
};

const claims = (overrides: Record<string, unknown> = {}) => ({
  answer: [],
  matter: [],
  stage: [],
  steps: [],
  documents: [
    {
      text: "The document proposes housing grants.",
      quote: "The bill would provide housing grants.",
      citation: {
        kind: "page" as const,
        stepId: "2",
        referenceId: "3",
        page: 2,
        url: "https://example.org/document.pdf",
      },
    },
  ],
  unresolved: [],
  ...overrides,
});

test("a fact is covered and cited by its expected page", () => {
  const result = scoreAnswer(
    label,
    { answerConfidence: "partial", claims: claims() },
    { retrieved: ["page:3:2"], collected: ["page:3:2"] },
  );
  assert.equal(result.factualCoverage, 1);
  assert.equal(result.citationSupport, 1);
  assert.equal(result.facts[0]?.cause, null);
  assert.equal(result.correctAbstention, true);
});

test("a claim that states the fact but cites another page is a synthesis failure", () => {
  const result = scoreAnswer(
    label,
    {
      answerConfidence: "partial",
      claims: claims({
        documents: [
          {
            text: "The document proposes housing grants.",
            quote: "The bill would provide housing grants.",
            citation: {
              kind: "page",
              stepId: "2",
              referenceId: "4",
              page: 2,
              url: "https://example.org/other.pdf",
            },
          },
        ],
      }),
    },
    {
      retrieved: ["page:3:2", "page:4:2"],
      collected: ["page:3:2", "page:4:2"],
    },
  );
  assert.equal(result.facts[0]?.covered, true);
  assert.equal(result.facts[0]?.cited, false);
  assert.equal(result.facts[0]?.cause, "synthesis");
});

test("a generic answer whose quote names the fact is not coverage", () => {
  const result = scoreAnswer(
    label,
    {
      answerConfidence: "partial",
      claims: claims({
        documents: [
          {
            text: "A proceeding step is documented.",
            quote: "The bill would provide housing grants.",
            citation: {
              kind: "page",
              stepId: "2",
              referenceId: "3",
              page: 2,
              url: "https://example.org/document.pdf",
            },
          },
        ],
      }),
    },
    { retrieved: ["page:3:2"], collected: ["page:3:2"] },
  );
  assert.equal(result.facts[0]?.covered, false);
  assert.equal(result.facts[0]?.cause, "synthesis");
});

test("missing evidence is classified by the stage that dropped it", () => {
  const cases: Array<
    [
      { retrieved: string[]; collected: string[] },
      "retrieval" | "dossier" | "synthesis",
    ]
  > = [
    [{ retrieved: [], collected: [] }, "retrieval"],
    [{ retrieved: ["page:3:2"], collected: [] }, "dossier"],
    [{ retrieved: ["page:3:2"], collected: ["page:3:2"] }, "synthesis"],
  ];
  for (const [availability, cause] of cases) {
    const result = scoreAnswer(
      label,
      { answerConfidence: "partial", claims: claims({ documents: [] }) },
      availability,
    );
    assert.equal(result.factualCoverage, 0);
    assert.equal(result.facts[0]?.cause, cause);
  }
});

test("hyphenated claim text still matches a term", () => {
  const result = scoreAnswer(
    {
      ...label,
      facts: [
        {
          text: "The grid-charge system is reorganised.",
          terms: ["Systematik", "Stromnetzentgelte"],
          evidenceIds: ["page:3:2"],
          quote: "Systematik der Stromnetzentgelte",
        },
      ],
    },
    {
      answerConfidence: "partial",
      claims: claims({
        documents: [
          {
            text: "Die Systema-\ntik der Stromnetz\u00ad entgelte wird neu geordnet.",
            quote: "die Systema-\ntik der Stromnetzentgelte",
            citation: {
              kind: "page",
              stepId: "2",
              referenceId: "3",
              page: 2,
              url: "https://example.org/document.pdf",
            },
          },
        ],
      }),
    },
    { retrieved: ["page:3:2"], collected: ["page:3:2"] },
  );
  assert.equal(result.factualCoverage, 1);
  assert.equal(result.citationSupport, 1);
});

test("any listed supporting page counts as a citation", () => {
  const result = scoreAnswer(
    {
      ...label,
      facts: [
        {
          ...label.facts[0]!,
          evidenceIds: ["page:3:2", "page:5:2"],
        },
      ],
    },
    {
      answerConfidence: "partial",
      claims: claims({
        documents: [
          {
            text: "The document proposes housing grants.",
            quote: "The bill would provide housing grants.",
            citation: {
              kind: "page",
              stepId: "2",
              referenceId: "5",
              page: 2,
              url: "https://example.org/other.pdf",
            },
          },
        ],
      }),
    },
    {
      retrieved: ["page:5:2"],
      collected: ["page:5:2"],
    },
  );
  assert.equal(result.citationSupport, 1);
});

test("abstention is scored separately from factual coverage", () => {
  const abstain: AnswerLabel = {
    question: "What rules govern lunar mining?",
    language: "de",
    expectAbstain: true,
    facts: [],
  };
  const correct = scoreAnswer(
    abstain,
    {
      answerConfidence: "abstain",
      claims: claims({ documents: [] }),
    },
    { retrieved: [], collected: [] },
  );
  assert.equal(correct.factualCoverage, null);
  assert.equal(correct.citationSupport, null);
  assert.equal(correct.correctAbstention, true);

  const answered = scoreAnswer(
    abstain,
    { answerConfidence: "partial", claims: claims() },
    { retrieved: ["page:3:2"], collected: ["page:3:2"] },
  );
  assert.equal(answered.correctAbstention, false);
});

test("a qualification case requires the answer to name the missing fact", () => {
  const missing: AnswerLabel = {
    question: "How much did the truck toll raise in 2025?",
    language: "en",
    expectAbstain: false,
    expectMissing: ["2025"],
    facts: [],
  };
  const availability = { retrieved: [], collected: [] };
  assert.equal(
    scoreAnswer(
      missing,
      {
        answerConfidence: "partial",
        qualification: "The stored evidence does not contain the 2025 figure.",
        claims: claims(),
      },
      availability,
    ).qualified,
    true,
  );
  assert.equal(
    scoreAnswer(
      missing,
      {
        answerConfidence: "partial",
        qualification: "The stored evidence does not establish every part.",
        claims: claims(),
      },
      availability,
    ).qualified,
    false,
  );
});

test("the mean ignores cases without expected facts", () => {
  assert.equal(meanScore([1, null, 0]), 0.5);
  assert.equal(meanScore([null]), null);
});
