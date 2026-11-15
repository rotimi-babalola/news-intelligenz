import assert from "node:assert/strict";
import { test } from "node:test";
import {
  documentEmbeddingIdentity,
  documentProcessingIdentity,
  proceedingEmbeddingIdentity,
  stepEmbeddingIdentity,
} from "../src/dip/jobs/identity.js";
import {
  EMBED_DOCUMENT,
  EMBED_PROCEEDING,
  EMBED_STEP,
  PROCESS_DOCUMENT,
} from "../src/dip/constants.js";

const RUN = "run-1";

function proceeding(versionNo = 1, model?: string) {
  return proceedingEmbeddingIdentity({
    runId: RUN,
    itemIndex: 3,
    electoralTerm: 21,
    apiId: "123",
    versionNo,
    model,
  });
}

function document(
  pdfUrl = "https://example.org/a.pdf",
  documentDate = new Date("2026-10-09T00:00:00Z"),
) {
  return documentProcessingIdentity({
    runId: RUN,
    itemIndex: null,
    electoralTerm: 21,
    stepApiId: "step-1",
    referenceId: "ref-1",
    pdfUrl,
    documentDate,
  });
}

function chunk(
  overrides: {
    pageNo?: number;
    model?: string;
    referenceId?: string;
    variantNo?: number;
  } = {},
) {
  return documentEmbeddingIdentity({
    runId: RUN,
    itemIndex: null,
    electoralTerm: 21,
    referenceId: overrides.referenceId ?? "ref-1",
    variantNo: overrides.variantNo ?? 2,
    pageNo: overrides.pageNo ?? 1,
    chunkNo: 3,
    model: overrides.model,
  });
}

test("record, document and chunk keys keep their existing formats", () => {
  assert.equal(
    proceeding().dedupeKey,
    JSON.stringify([RUN, EMBED_PROCEEDING, "123", 1]),
  );
  assert.equal(
    proceeding(4, "model-a").dedupeKey,
    JSON.stringify(["reindex", "model-a", EMBED_PROCEEDING, "123", 4]),
  );
  assert.equal(
    stepEmbeddingIdentity({
      runId: RUN,
      itemIndex: 3,
      electoralTerm: 21,
      apiId: "456",
      versionNo: 2,
    }).dedupeKey,
    JSON.stringify([RUN, EMBED_STEP, "456", 2]),
  );
  assert.equal(
    document().dedupeKey,
    JSON.stringify([
      PROCESS_DOCUMENT,
      "ref-1",
      "https://example.org/a.pdf",
      "2026-10-09T00:00:00.000Z",
    ]),
  );
  assert.equal(
    chunk().dedupeKey,
    JSON.stringify([EMBED_DOCUMENT, "ref-1", 2, 1, 3]),
  );
  assert.equal(
    chunk({ model: "model-a" }).dedupeKey,
    JSON.stringify(["reindex", "model-a", EMBED_DOCUMENT, "ref-1", 2, 1, 3]),
  );
});

test("identity builds source metadata and payload with the key", () => {
  assert.deepEqual(proceeding().source, {
    kind: "dip_endpoint",
    key: "/vorgang",
    scope: { electoralTerm: "21" },
  });
  assert.deepEqual(proceeding().payload, { apiId: "123", versionNo: 1 });
  assert.deepEqual(proceeding(2, "model-a").payload, {
    apiId: "123",
    versionNo: 2,
    model: "model-a",
  });
  assert.deepEqual(document().source, {
    kind: "dip_endpoint",
    key: "/vorgangsposition",
    scope: { electoralTerm: "21" },
  });
  assert.deepEqual(document().payload, {
    stepApiId: "step-1",
    referenceId: "ref-1",
    pdfUrl: "https://example.org/a.pdf",
    electoralTerm: 21,
  });
  assert.deepEqual(chunk().payload, {
    referenceId: "ref-1",
    variantNo: 2,
    pageNo: 1,
    chunkNo: 3,
  });
});

test("replaying identical input keeps the identity and changing a field replaces it", () => {
  assert.equal(proceeding().dedupeKey, proceeding().dedupeKey);
  assert.equal(document().dedupeKey, document().dedupeKey);
  assert.equal(chunk().dedupeKey, chunk().dedupeKey);

  // Every field that defines the work changes the key; unrelated fields do not.
  assert.notEqual(
    document().dedupeKey,
    document("https://example.org/b.pdf").dedupeKey,
  );
  assert.notEqual(
    document().dedupeKey,
    document(undefined, new Date("2026-10-10T00:00:00Z")).dedupeKey,
  );
  assert.notEqual(chunk().dedupeKey, chunk({ pageNo: 2 }).dedupeKey);
  assert.notEqual(chunk().dedupeKey, chunk({ referenceId: "ref-2" }).dedupeKey);
  assert.notEqual(chunk().dedupeKey, chunk({ variantNo: 3 }).dedupeKey);
  assert.notEqual(
    proceeding().dedupeKey,
    proceedingEmbeddingIdentity({
      runId: RUN,
      itemIndex: 3,
      electoralTerm: 21,
      apiId: "124",
      versionNo: 1,
    }).dedupeKey,
  );
  assert.notEqual(
    proceeding().dedupeKey,
    proceedingEmbeddingIdentity({
      runId: "run-2",
      itemIndex: 3,
      electoralTerm: 21,
      apiId: "123",
      versionNo: 1,
    }).dedupeKey,
  );

  // A model-specific reindex is separate work from the original embedding.
  assert.notEqual(proceeding().dedupeKey, proceeding(1, "model-a").dedupeKey);
  assert.equal(
    proceeding(1, "model-a").dedupeKey,
    proceeding(1, "model-a").dedupeKey,
  );
  assert.notEqual(
    proceeding(1, "model-a").dedupeKey,
    proceeding(1, "model-b").dedupeKey,
  );
});
