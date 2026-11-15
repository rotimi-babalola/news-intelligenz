import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCitedDocumentVariant,
  isCurrentDocumentVariant,
  resolveDocumentCitation,
  type DocumentReference,
  type DocumentVariant,
} from "../src/dip/documents/citation.js";

const pdfUrl = "https://dserver.bundestag.de/btd/21/010/2110010.pdf";
const reference: DocumentReference = {
  stepApiId: "10",
  proceedingApiId: "340161",
  referenceId: "291522",
  documentNumber: "21/1001",
  pdfUrl,
  documentDate: null,
  metadata: { herausgeber: "BT", dokumentart: "Drucksache" },
  observedAt: new Date("2026-10-09T00:00:00Z"),
  step: { institution: "BT", documentType: "Drucksache" },
};
const variant: DocumentVariant = {
  id: "content",
  variantNo: 2,
  byteHash: "hash",
  pageCount: 3,
  objectKey: "documents/291522/hash.pdf",
  bytes: null,
  sourceUrl: pdfUrl,
  requestedUrl: pdfUrl,
  fetchedAt: new Date("2026-10-09T00:00:00Z"),
};

test("the currency rule compares the latest variant's requested url", () => {
  assert.equal(isCurrentDocumentVariant(pdfUrl, pdfUrl), true);
  assert.equal(isCurrentDocumentVariant(`${pdfUrl}?revised`, pdfUrl), false);
  assert.equal(isCurrentDocumentVariant(pdfUrl, null), false);
  assert.equal(isCurrentDocumentVariant(null, null), false);
});

test("one status answers what may be shown from a reference", () => {
  const ineligible = resolveDocumentCitation(
    { ...reference, metadata: {} },
    variant,
  );
  assert.equal(ineligible.status, "metadata-only");
  assert.equal(
    ineligible.status === "metadata-only" && ineligible.eligibility.reason,
    "Unconfirmed official issuer",
  );

  const missing = resolveDocumentCitation(reference, null);
  assert.equal(missing.status, "missing");
  assert.equal(
    missing.status === "missing" && missing.eligibility.status,
    "excerpt-eligible",
  );

  const stale = resolveDocumentCitation(
    { ...reference, pdfUrl: `${pdfUrl}?revised` },
    variant,
  );
  assert.equal(stale.status, "stale");

  const current = resolveDocumentCitation(reference, variant);
  assert.equal(current.status, "current");
  assert.equal(current.status === "current" && current.variant.variantNo, 2);
});

test("a cited hit stays valid only for the variant it was indexed from", () => {
  assert.equal(isCitedDocumentVariant(variant, { variantNo: 2, pdfUrl }), true);
  assert.equal(
    isCitedDocumentVariant(variant, { variantNo: 1, pdfUrl }),
    false,
  );
  assert.equal(
    isCitedDocumentVariant(variant, { variantNo: 2, pdfUrl: `${pdfUrl}?new` }),
    false,
  );
});
