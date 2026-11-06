import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyDocumentReference,
  readDocumentExcerpt,
} from "../src/dip/excerpts.js";

const bt = {
  institution: "BT",
  documentType: "Drucksache",
  documentNumber: "21/1001",
  pdfUrl: "https://dserver.bundestag.de/btd/21/010/2110010.pdf",
  metadata: {
    herausgeber: "BT",
    dokumentart: "Drucksache",
    urheber: ["Fraktion DIE LINKE"],
  },
};

test("confirmed BT and BR works carry the required excerpt evidence", () => {
  assert.deepEqual(readDocumentExcerpt(bt, 2, "Passage"), {
    status: "excerpt-eligible",
    reason: "Confirmed official parliamentary document",
    source: "Deutscher Bundestag/Bundesrat – DIP",
    document: "BT-Drs. 21/1001",
    originalUrl: bt.pdfUrl,
    page: 2,
    text: "Passage",
    changes: "Text extracted from PDF and excerpted",
  });
  assert.equal(
    classifyDocumentReference({
      ...bt,
      institution: "BR",
      documentNumber: "583/26",
      metadata: { herausgeber: "BR", dokumentart: "Plenarprotokoll" },
      documentType: "Plenarprotokoll",
    }).document,
    "BR-PlPr. 583/26",
  );
});

test("incomplete and conflicting metadata fail closed without page text", () => {
  for (const reference of [
    { ...bt, metadata: {} },
    { ...bt, documentNumber: "" },
    { ...bt, institution: "BR" },
    { ...bt, metadata: { herausgeber: "BT", dokumentart: "Anlage" } },
    { ...bt, pdfUrl: null },
    { ...bt, metadata: { herausgeber: "Dritte", dokumentart: "Drucksache" } },
  ]) {
    const result = readDocumentExcerpt(reference, 1, "Private page text");
    assert.equal(result.status, "metadata-only");
    assert.equal("text" in result, false);
  }
  assert.equal(
    readDocumentExcerpt(bt, null, "Private page text").status,
    "metadata-only",
  );
});
