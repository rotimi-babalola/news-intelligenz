import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBrief } from "../src/dip/explain/brief.js";
import type {
  Claim,
  Claims,
  Dossier,
  Evidence,
} from "../src/dip/explain/types.js";
import { readerAnswer } from "../src/reader/index.js";

const dossier = {
  apiId: "845123",
  ranking: { strongestEvidence: 0.93 },
} as Dossier;
const rawQuote = "RAW QUOTE that must not reach the reader";

const pageCitation = (page: number): Evidence["citation"] => ({
  kind: "page",
  stepId: "600001",
  referenceId: "777777",
  page,
  url: "https://dserver.bundestag.de/btd/21/082/2108208.pdf",
});
const stepCitation = (stepId: string): Evidence["citation"] => ({
  kind: "step",
  stepId,
  url: `https://search.dip.bundestag.de/api/v1/vorgangsposition/${stepId}`,
});

const claim = (text: string, citation: Evidence["citation"]): Claim => ({
  text,
  quote: rawQuote,
  citation,
});

const emptyClaims = (): Claims => ({
  answer: [],
  matter: [],
  stage: [],
  steps: [],
  documents: [],
  unresolved: [],
});

const supportedClaims = (): Claims => ({
  answer: [claim("The bill is at its first reading.", stepCitation("600002"))],
  matter: [claim("The bill concerns housing grants.", stepCitation("600001"))],
  stage: [
    claim("The latest step is the first reading.", stepCitation("600002")),
  ],
  steps: [
    claim("First reading took place.", stepCitation("600001")),
    claim("Committee review followed.", stepCitation("600002")),
  ],
  documents: [claim("The document proposes grants.", pageCitation(8))],
  unresolved: [claim("The funding volume is not stated.", pageCitation(9))],
});

test("a supported generated brief reads in order and cites every claim", () => {
  const answer = readerAnswer(
    buildBrief(dossier, "en", "What does the bill do?", supportedClaims(), []),
  );
  assert.equal(answer.status, "supported");
  assert.equal(answer.limitation, null);
  assert.deepEqual(
    answer.shortAnswer?.map((item) => item.text),
    [
      "The bill is at its first reading.",
      "The bill concerns housing grants.",
      "The latest step is the first reading.",
    ],
  );
  assert.deepEqual(
    answer.context?.map((item) => item.text),
    ["The document proposes grants.", "The funding volume is not stated."],
  );
  assert.equal(answer.timeline?.length, 2);
  assert.equal(answer.shortAnswer?.[0]?.citation.label, "Proceeding step");
  assert.equal(answer.context?.[0]?.citation.label, "Document, page 8");
  for (const item of [
    ...(answer.shortAnswer ?? []),
    ...(answer.context ?? []),
    ...(answer.timeline ?? []),
  ]) {
    assert.ok(item.text.length > 0);
    assert.ok(item.citation.label.length > 0);
    assert.ok(item.citation.url.startsWith("https://"));
  }
});

test("visible text never carries IDs, scores, quotes or JSON shapes", () => {
  const answer = readerAnswer(
    buildBrief(dossier, "en", "What does the bill do?", supportedClaims(), []),
  );
  const visible = [
    ...(answer.shortAnswer ?? []),
    ...(answer.context ?? []),
    ...(answer.timeline ?? []),
  ]
    .map((item) => `${item.text} ${item.citation.label}`)
    .join(" ");
  for (const secret of [
    rawQuote,
    "845123",
    "0.93",
    "777777",
    "600001",
    "600002",
  ])
    assert.ok(!visible.includes(secret), `leaked ${secret}`);
  const rendered = JSON.stringify(answer);
  for (const shape of [
    rawQuote,
    "845123",
    "0.93",
    "retrievalRelevance",
    "proceedingApiId",
  ])
    assert.ok(!rendered.includes(shape), `leaked ${shape}`);
});

test("an absent lead answer falls back to the matter and stage", () => {
  const claims = supportedClaims();
  claims.answer = [];
  const answer = readerAnswer(
    buildBrief(dossier, "en", "What does the bill do?", claims, []),
  );
  assert.deepEqual(
    answer.shortAnswer?.map((item) => item.text),
    [
      "The bill concerns housing grants.",
      "The latest step is the first reading.",
    ],
  );
});

test("a lead claim repeated in matter or stage is shown once", () => {
  const claims = supportedClaims();
  claims.stage = [
    claim("The bill is at its first reading.", stepCitation("600002")),
  ];
  const answer = readerAnswer(
    buildBrief(dossier, "en", "What is the bill's stage?", claims, []),
  );
  assert.deepEqual(
    answer.shortAnswer?.map((item) => item.text),
    ["The bill is at its first reading.", "The bill concerns housing grants."],
  );
});

test("a complete brief without a lead answer is still supported", () => {
  const claims = supportedClaims();
  claims.answer = [];
  const answer = readerAnswer(
    buildBrief(dossier, "en", "What does the bill do?", claims, []),
  );
  assert.equal(answer.status, "supported");
  assert.equal(answer.limitation, null);
  assert.ok(answer.shortAnswer?.length);
});

test("a lone lead claim is a partial answer, not an abstention", () => {
  const claims = emptyClaims();
  claims.answer = [
    claim("The bill is at its first reading.", stepCitation("600002")),
  ];
  const answer = readerAnswer(
    buildBrief(dossier, "en", "What is the bill's stage?", claims, []),
  );
  assert.equal(answer.status, "partial");
  assert.deepEqual(
    answer.shortAnswer?.map((item) => item.text),
    ["The bill is at its first reading."],
  );
});

test("a partial generated brief drops the empty category and states its limitation", () => {
  const claims = supportedClaims();
  claims.documents = [];
  claims.unresolved = [];
  const answer = readerAnswer(
    buildBrief(dossier, "de", "Worum geht es?", claims, []),
  );
  assert.equal(answer.status, "partial");
  assert.ok(!("context" in answer));
  assert.ok(answer.shortAnswer?.length);
  assert.equal(
    answer.limitation,
    "Die gespeicherten Belege klären nicht alle Teile der Antwort.",
  );
  assert.equal(answer.shortAnswer?.[0]?.citation.label, "Verfahrensschritt");
});

test("an abstention is a limitation statement with no claim groups", () => {
  const en = readerAnswer(
    buildBrief(dossier, "en", "An unknown question", emptyClaims(), []),
  );
  assert.equal(en.status, "abstain");
  assert.ok(!("shortAnswer" in en));
  assert.ok(!("context" in en));
  assert.ok(!("timeline" in en));
  assert.equal(
    en.limitation,
    "The stored evidence does not answer this question.",
  );

  const de = readerAnswer(
    buildBrief(dossier, "de", "Eine unbekannte Frage", emptyClaims(), []),
  );
  assert.equal(
    de.limitation,
    "Die gespeicherten Belege beantworten diese Frage nicht.",
  );
});

test("missing facts name what the evidence cannot answer", () => {
  const answer = readerAnswer(
    buildBrief(
      dossier,
      "de",
      "Wie hoch waren die Einnahmen 2025?",
      supportedClaims(),
      ["2025"],
    ),
  );
  assert.equal(answer.status, "partial");
  assert.equal(
    answer.limitation,
    "Die gespeicherten Belege enthalten die gefragten Angaben nicht: 2025.",
  );
});

test("a single documented step does not become a timeline but stays in context", () => {
  const claims = supportedClaims();
  claims.steps = [
    claim("The first reading took place.", stepCitation("600002")),
  ];
  const answer = readerAnswer(
    buildBrief(dossier, "en", "What happened?", claims, []),
  );
  assert.ok(!("timeline" in answer));
  assert.ok(answer.shortAnswer?.length);
  assert.ok(
    answer.context?.some(
      (item) => item.text === "The first reading took place.",
    ),
  );
});

test("several claims about one step are context, not a timeline", () => {
  const claims = supportedClaims();
  claims.steps = [
    claim("First reading opened.", stepCitation("600001")),
    claim("First reading closed.", stepCitation("600001")),
  ];
  const answer = readerAnswer(
    buildBrief(dossier, "en", "What happened?", claims, []),
  );
  assert.ok(!("timeline" in answer));
  const context = answer.context?.map((item) => item.text) ?? [];
  assert.ok(context.includes("First reading opened."));
  assert.ok(context.includes("First reading closed."));
});

test("a lone step with no direct answer becomes the short answer", () => {
  const claims = emptyClaims();
  claims.steps = [
    claim("The first reading took place.", stepCitation("600003")),
  ];
  const answer = readerAnswer(
    buildBrief(dossier, "en", "What happened?", claims, []),
  );
  assert.equal(answer.status, "partial");
  assert.deepEqual(
    answer.shortAnswer?.map((item) => item.text),
    ["The first reading took place."],
  );
  assert.ok(!("timeline" in answer));
});
