import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import {
  getSourceDocumentPage,
  pdfPageUrl,
  sourceDocumentUrl,
} from "../src/dip/documents/source.js";
import {
  getSourceStep,
  sourceProceedingUrl,
  sourceStepUrl,
} from "../src/dip/proceedings/source.js";
import { STALE_REVISION_REASON } from "../src/dip/documents/citation.js";

const date = new Date("2026-10-10T00:00:00.000Z");
const pdfUrl = "https://example.org/document.pdf";

const reference = {
  stepApiId: "2",
  proceedingApiId: "1",
  referenceId: "3",
  documentNumber: "21/1",
  pdfUrl,
  documentDate: date,
  metadata: { herausgeber: "BT", dokumentart: "Drucksache" },
  observedAt: date,
  step: { institution: "BT", documentType: "Drucksache" },
};

const content = {
  id: "content-one",
  referenceId: "3",
  variantNo: 1,
  byteHash: "hash-one",
  byteSize: 100,
  pageCount: 5,
  objectKey: "documents/3/hash-one.pdf",
  bytes: null,
  sourceUrl: pdfUrl,
  requestedUrl: pdfUrl,
  fetchedAt: date,
  isLatest: true,
};

function documentClient({
  contentRow = content,
  pageRow = { contentId: "content-one", pageNo: 2, text: "Housing grants." },
  sections = [
    {
      contentId: "content-one",
      sectionNo: 1,
      label: "§ 1",
      title: "Grants",
      startPage: 1,
      endPage: 3,
    },
  ],
  referenceRow = reference,
}: {
  contentRow?: typeof content | null;
  pageRow?: { contentId: string; pageNo: number; text: string } | null;
  sections?: {
    contentId: string;
    sectionNo: number;
    label: string;
    title: string;
    startPage: number;
    endPage: number;
  }[];
  referenceRow?: typeof reference | null;
} = {}) {
  return {
    documentReference: { findFirst: async () => referenceRow },
    documentContent: { findFirst: async () => contentRow },
    documentPage: { findUnique: async () => pageRow },
    documentSection: { findMany: async () => sections },
  } as unknown as PrismaClient;
}

const stepRow = {
  apiId: "2",
  proceedingApiId: "1",
  institution: "BT",
  stepLabel: "First reading",
  title: "Housing bill introduced",
  documentType: "Drucksache",
  documentDate: date,
  sourceUpdatedAt: date,
  firstObservedAt: date,
  lastObservedAt: date,
  metadata: { text: "The bill was introduced." },
  latestVersionNo: 1,
};

const proceedingRow = {
  apiId: "1",
  title: "Housing bill",
  proceedingType: "Bill",
  deliberationState: "In deliberation",
  metadata: { abstract: "A bill about housing grants." },
  documentDate: date,
  sourceUpdatedAt: date,
  firstObservedAt: date,
  lastObservedAt: date,
  latestVersionNo: 1,
  versions: [{ id: "p1", observedAt: date }],
};

function stepClient({
  found = stepRow,
  steps = [
    {
      ...stepRow,
      versions: [{ id: "s1", observedAt: date }],
      documentReference: reference,
    },
  ],
}: { found?: typeof stepRow | null; steps?: unknown[] } = {}) {
  return {
    proceedingStep: {
      findUnique: async () => found,
      findMany: async () => steps,
    },
    proceeding: { findUnique: async () => proceedingRow },
  } as unknown as PrismaClient;
}

test("a step source view carries its text, institution and document", async () => {
  const view = await getSourceStep(stepClient(), "2");
  assert.equal(view?.step.institution, "BT");
  assert.equal(view?.step.label, "First reading");
  assert.equal(view?.step.text, "The bill was introduced.");
  assert.equal(view?.step.document?.referenceId, "3");
  assert.equal(view?.proceeding?.title, "Housing bill");
  assert.equal(view?.parentMissing, false);
  assert.equal(sourceStepUrl("2"), "/source/step/2");
  assert.equal(sourceProceedingUrl("1"), "/source/proceeding/1");
});

test("a step source view is absent for a missing or non-numeric id", async () => {
  assert.equal(await getSourceStep(stepClient({ found: null }), "2"), null);
  assert.equal(await getSourceStep(stepClient(), "abc"), null);
});

test("a stored document page carries its text and covering section", async () => {
  const view = await getSourceDocumentPage(documentClient(), "3", 2);
  assert.equal(view.status, "available");
  if (view.status !== "available") return;
  assert.equal(view.text, "Housing grants.");
  assert.equal(view.source.documentNumber, "21/1");
  assert.equal(view.source.pdfUrl, pdfUrl);
  assert.deepEqual(view.section, {
    label: "§ 1",
    title: "Grants",
    startPage: 1,
    endPage: 3,
  });
  assert.equal(sourceDocumentUrl("3", 2), "/source/document/3?page=2");
  assert.equal(pdfPageUrl(pdfUrl, 2), `${pdfUrl}#page=2`);
});

test("an unprocessed document reports its reason with the PDF link", async () => {
  const view = await getSourceDocumentPage(
    documentClient({ contentRow: null }),
    "3",
    2,
  );
  assert.equal(view.status, "not-processed");
  if (view.status !== "not-processed") return;
  assert.match(view.reason, /not been processed/u);
  assert.equal(view.source.pdfUrl, pdfUrl);
});

test("a metadata-only document reports why its text is withheld", async () => {
  const view = await getSourceDocumentPage(
    documentClient({
      referenceRow: {
        ...reference,
        metadata: {},
      } as unknown as typeof reference,
    }),
    "3",
    2,
  );
  assert.equal(view.status, "not-processed");
  if (view.status !== "not-processed") return;
  assert.equal(view.reason, "Unconfirmed official issuer");
  assert.equal(view.source.pdfUrl, pdfUrl);
});

test("a stale document revision is not shown as stored text", async () => {
  const view = await getSourceDocumentPage(
    documentClient({
      contentRow: { ...content, requestedUrl: "https://example.org/old.pdf" },
    }),
    "3",
    2,
  );
  assert.equal(view.status, "not-processed");
  if (view.status !== "not-processed") return;
  assert.equal(view.reason, STALE_REVISION_REASON);
});

test("a page that is not stored is distinct from an unprocessed document", async () => {
  const view = await getSourceDocumentPage(
    documentClient({ pageRow: null }),
    "3",
    2,
  );
  assert.equal(view.status, "page-missing");
  if (view.status !== "page-missing") return;
  assert.equal(view.page, 2);
  assert.equal(view.pageCount, 5);
  assert.equal(view.source.pdfUrl, pdfUrl);
});

test("an unknown reference resolves to no source view", async () => {
  const view = await getSourceDocumentPage(
    documentClient({ referenceRow: null }),
    "3",
    2,
  );
  assert.deepEqual(view, { status: "unknown" });
});
