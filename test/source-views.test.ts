import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import {
  getSourceDocumentOutline,
  getSourceDocumentPage,
  isSafePdfUrl,
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
  referenceForStepRow = referenceRow,
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
  referenceForStepRow?: typeof reference | null;
} = {}) {
  return {
    documentReference: {
      findFirst: async () => referenceRow,
      findUnique: async ({ where }: { where: { stepApiId: string } }) =>
        referenceForStepRow?.stepApiId === where.stepApiId
          ? referenceForStepRow
          : null,
    },
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
const sourceStepRow = {
  ...stepRow,
  versions: [{ id: "s1", observedAt: date }],
  documentReference: reference,
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
  found = sourceStepRow,
  parent = proceedingRow,
}: {
  found?: typeof sourceStepRow | null;
  parent?: typeof proceedingRow | null;
} = {}) {
  return {
    proceedingStep: {
      findUnique: async () => found,
      findMany: async () => {
        throw new Error("A step view must not load the full timeline");
      },
    },
    proceeding: { findUnique: async () => parent },
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

test("an orphan step still has a source view", async () => {
  const view = await getSourceStep(stepClient({ parent: null }), "2");
  assert.equal(view?.step.apiId, "2");
  assert.equal(view?.proceeding, null);
  assert.equal(view?.parentMissing, true);
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
  assert.equal(
    sourceDocumentUrl("3", { page: 2, stepId: "2" }),
    "/source/document/3?page=2&step=2",
  );
  assert.equal(sourceDocumentUrl("3"), "/source/document/3");
  assert.equal(pdfPageUrl(pdfUrl, 2), `${pdfUrl}#page=2`);
  assert.equal(isSafePdfUrl(pdfUrl), true);
  assert.equal(isSafePdfUrl("http://example.org/document.pdf"), false);
  assert.equal(isSafePdfUrl("javascript:alert(1)"), false);
  assert.equal(isSafePdfUrl(null), false);
});

test("a cited page uses its step's reference when another step shares the document", async () => {
  const client = documentClient({
    referenceRow: {
      ...reference,
      stepApiId: "4",
      proceedingApiId: "5",
      pdfUrl: "https://example.org/new.pdf",
    },
    referenceForStepRow: reference,
  });
  const cited = await getSourceDocumentPage(client, "3", 2, "2");
  assert.equal(cited.status, "available");
  if (cited.status !== "available") return;
  assert.equal(cited.text, "Housing grants.");
  assert.equal(cited.source.stepApiId, "2");
  assert.equal(cited.source.proceedingApiId, "1");
  assert.equal(cited.source.pdfUrl, pdfUrl);

  const unscoped = await getSourceDocumentPage(client, "3", 2);
  assert.equal(unscoped.status, "not-processed");
  assert.deepEqual(await getSourceDocumentPage(client, "7", 2, "2"), {
    status: "unknown",
  });
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
  assert.equal(view.status, "metadata-only");
  if (view.status !== "metadata-only") return;
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

test("a page beyond the stored range is answered without a database read", async () => {
  const view = await getSourceDocumentPage(
    documentClient({ pageRow: null }),
    "3",
    99,
  );
  assert.equal(view.status, "page-missing");
  if (view.status !== "page-missing") return;
  assert.equal(view.page, 99);
});

test("the step view can link the current document's sections", async () => {
  const sections = await getSourceDocumentOutline(documentClient(), "3", "2");
  assert.deepEqual(sections, [
    { label: "§ 1", title: "Grants", startPage: 1, endPage: 3 },
  ]);
  assert.deepEqual(
    await getSourceDocumentOutline(documentClient({ contentRow: null }), "3"),
    [],
  );
  assert.deepEqual(
    await getSourceDocumentOutline(documentClient(), "3", "4"),
    [],
  );
});

test("an unknown reference resolves to no source view", async () => {
  const view = await getSourceDocumentPage(
    documentClient({ referenceRow: null }),
    "3",
    2,
  );
  assert.deepEqual(view, { status: "unknown" });
});
