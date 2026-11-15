import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDocumentEvidence,
  buildDossiers,
  hasCitablePageEvidence,
} from "../src/dip/search/dossier-builders.js";
import type { ProceedingTimeline } from "../src/dip/proceedings/timeline.js";
import type { DipHit } from "../src/dip/search/search.js";

type Hit = DipHit;
type Timeline = ProceedingTimeline;

const observedAt = "2026-10-10T00:00:00.000Z";
const source = (apiId: string) => ({
  endpoint: "/vorgangsposition",
  apiId,
  url: `https://example.org/${apiId}`,
});
const step = (apiId: string, day: number) => ({
  apiId,
  institution: "BR",
  label: "Beratung",
  title: "Step",
  text: null,
  documentType: "Drucksache",
  documentDate: `2026-10-${day}T00:00:00.000Z`,
  sourceUpdatedAt: `2026-10-${day}T00:00:00.000Z`,
  firstObservedAt: observedAt,
  lastObservedAt: observedAt,
  versionNo: 1,
  versionId: null,
  versionObservedAt: null,
  sourceUrl: source(apiId).url,
  document: {
    referenceId: `doc-${apiId}`,
    number: "1",
    date: null,
    pdfUrl: `https://example.org/${apiId}.pdf`,
    metadata: {},
    observedAt,
  },
});
const timeline = (
  apiId: string,
  steps: Timeline["steps"],
  missing = false,
): Timeline => ({
  apiId,
  parentMissing: missing,
  proceeding: missing
    ? null
    : {
        title: `Proceeding ${apiId}`,
        type: "Bill",
        deliberationState: null,
        summary: null,
        documentDate: null,
        sourceUpdatedAt: "2026-10-10T00:00:00.000Z",
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        versionNo: 1,
        versionId: null,
        versionObservedAt: null,
        sourceUrl: `https://example.org/${apiId}`,
      },
  steps,
});
const hit = (
  entity: "vorgang" | "vorgangsposition" | "dokument",
  apiId: string,
  proceedingApiId: string,
  score: number,
  page = 1,
): Hit => {
  const stepId = entity === "dokument" ? apiId.replace("doc-", "") : apiId;
  return {
    entity,
    apiId,
    proceedingApiId,
    versionNo: 1,
    score,
    title: "",
    summary: null,
    stepLabel: null,
    ...(entity === "dokument"
      ? { page, chunk: 1, passage: "Matching passage" }
      : {}),
    document: {
      referenceId: apiId,
      number: "1",
      page,
      pdfUrl: `https://example.org/${stepId}.pdf`,
    },
    excerpt: {
      status: "excerpt-eligible",
      text: "Matching passage",
      page,
      originalUrl: `https://example.org/${stepId}.pdf`,
    },
    source: source(stepId),
  } as Hit;
};

test("dossiers group current hits by proceeding and expose ranking contributions", () => {
  const hits = [
    hit("dokument", "doc-10", "1", 0.95, 1),
    hit("dokument", "doc-10", "1", 0.94, 2),
    hit("vorgang", "2", "2", 0.9),
    hit("vorgangsposition", "10", "1", 0.8),
    hit("vorgangsposition", "stale", "1", 0.99),
  ];
  const dossiers = buildDossiers(
    hits,
    new Map([
      ["1", timeline("1", [step("10", 10), step("11", 11)])],
      ["2", timeline("2", [])],
    ]),
    2,
    new Date("2026-10-20T00:00:00.000Z"),
  );
  assert.deepEqual(
    dossiers.map((d) => d.apiId),
    ["1", "2"],
  );
  assert.deepEqual(
    dossiers[0]?.evidence.map((e) => [e.entity, e.apiId, e.page]),
    [
      ["dokument", "doc-10", 1],
      ["dokument", "doc-10", 2],
      ["vorgangsposition", "10", undefined],
    ],
  );
  assert.equal(dossiers[0]?.ranking.strongestEvidence, 0.95);
  assert.equal(dossiers[0]?.ranking.stepCount, 0.01);
  assert.equal(dossiers[0]?.ranking.currentActivity, 0.02);
  assert.equal(dossiers[0]?.firstActivity, "2026-10-10T00:00:00.000Z");
  assert.equal(dossiers[0]?.lastActivity, "2026-10-11T00:00:00.000Z");
});

test("dossiers retain orphan timelines and omit unavailable or changed evidence", () => {
  const dossiers = buildDossiers(
    [
      hit("vorgangsposition", "10", "1", 0.8),
      hit("dokument", "doc-10", "1", 0.7),
      hit("vorgang", "missing", "missing", 1),
    ],
    new Map([
      ["1", timeline("1", [{ ...step("10", 10), document: null }], true)],
    ]),
    10,
  );
  assert.equal(dossiers.length, 1);
  assert.equal(dossiers[0]?.parentMissing, true);
  assert.equal(dossiers[0]?.title, null);
  assert.deepEqual(
    dossiers[0]?.evidence.map((e) => e.entity),
    ["vorgangsposition"],
  );
});

test("only an excerpt-eligible document counts as citable page evidence", () => {
  assert.equal(hasCitablePageEvidence([]), false);
  assert.equal(
    hasCitablePageEvidence([hit("vorgangsposition", "10", "1", 0.8)]),
    false,
  );
  assert.equal(
    hasCitablePageEvidence([
      {
        ...hit("dokument", "doc-10", "1", 0.7),
        excerpt: { status: "metadata-only", reason: "Unconfirmed issuer" },
      } as Hit,
    ]),
    false,
  );
  assert.equal(
    hasCitablePageEvidence([hit("dokument", "doc-10", "1", 0.7)]),
    true,
  );
});

test("enrichment adds distinct eligible pages up to the dossier document limit", () => {
  const [dossier] = buildDossiers(
    [hit("vorgangsposition", "10", "1", 0.8)],
    new Map([["1", timeline("1", [step("10", 10), step("11", 11)])]]),
    1,
  );
  const [enriched] = addDocumentEvidence(
    [dossier!],
    [
      hit("dokument", "doc-99", "1", 0.7),
      {
        ...hit("dokument", "doc-10", "1", 0.6),
        excerpt: { status: "metadata-only", reason: "Unconfirmed issuer" },
      } as Hit,
      hit("dokument", "doc-10", "1", 0.4, 5),
      hit("dokument", "doc-10", "1", 0.39, 1),
      hit("dokument", "doc-11", "1", 0.38),
    ],
  );
  assert.equal(enriched?.score, dossier?.score);
  assert.deepEqual(
    enriched?.evidence.map((e) => [e.entity, e.apiId, e.page]),
    [
      ["vorgangsposition", "10", undefined],
      ["dokument", "doc-10", 5],
      ["dokument", "doc-11", 1],
    ],
  );
  assert.equal(
    addDocumentEvidence([enriched!], [hit("dokument", "doc-10", "1", 0.3)])[0]
      ?.evidence.length,
    3,
  );
});

test("documented activity can change proceeding rank", () => {
  const older = timeline("1", [step("10", 1)]);
  const recent = timeline("2", [step("20", 19)]);
  const dossiers = buildDossiers(
    [
      hit("vorgangsposition", "10", "1", 0.8),
      hit("vorgangsposition", "20", "2", 0.79),
    ],
    new Map([
      ["1", older],
      ["2", recent],
    ]),
    2,
    new Date("2026-10-20T00:00:00.000Z"),
  );
  assert.deepEqual(
    dossiers.map((d) => d.apiId),
    ["2", "1"],
  );
  assert.ok(dossiers[0]!.ranking.recency > dossiers[1]!.ranking.recency);
});

test("source corrections do not become parliamentary activity", () => {
  const partial = timeline(
    "1",
    [{ ...step("10", 10), documentDate: null }],
    true,
  );
  const [dossier] = buildDossiers(
    [hit("vorgangsposition", "10", "1", 0.8)],
    new Map([["1", partial]]),
    1,
  );
  assert.equal(dossier?.firstActivity, null);
  assert.equal(dossier?.lastActivity, null);
  assert.equal(dossier?.ranking.recency, 0);
  assert.equal(dossier?.ranking.currentActivity, 0);
});

test("future dated steps are not counted as current activity", () => {
  const [dossier] = buildDossiers(
    [hit("vorgangsposition", "10", "1", 0.8)],
    new Map([["1", timeline("1", [step("10", 21)])]]),
    1,
    new Date("2026-10-20T00:00:00.000Z"),
  );
  assert.equal(dossier?.ranking.recency, 0);
  assert.equal(dossier?.ranking.currentActivity, 0);
});
