import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stepContentHash, toStoredStep } from "../src/dip/util.js";

const dir = path.join("fixtures", "dip");

async function load(name: string) {
  return JSON.parse(await readFile(path.join(dir, name), "utf8")) as {
    cursor: string;
    numFound: number;
    documents: Record<string, unknown>[];
  };
}

const NUMERIC_ID = /^\d+$/;

test("vorgang fixtures carry required identity fields and tolerate missing summaries", async () => {
  const page = await load("vorgang-page1.json");
  assert.ok(page.cursor);
  assert.ok(page.documents.length > 0);
  let withoutSummary = 0;
  for (const doc of page.documents) {
    assert.match(String(doc["id"]), NUMERIC_ID);
    assert.equal(doc["typ"], "Vorgang");
    assert.ok(doc["vorgangstyp"]);
    assert.ok(doc["wahlperiode"]);
    assert.ok(doc["aktualisiert"]);
    assert.ok(doc["titel"]);
    assert.ok(!("vorgang_id" in doc), "fundstelle/vorgang_id belong on steps");
    assert.ok(!("fundstelle" in doc), "fundstelle/vorgang_id belong on steps");
    if (doc["abstract"] === undefined) withoutSummary++;
  }
  assert.ok(
    withoutSummary > 0,
    "fixture must include a summary-less proceeding",
  );
});

test("vorgang terminal page repeats the cursor (pagination end signal)", async () => {
  const first = await load("vorgang-page1.json");
  const terminal = await load("vorgang-page2-terminal.json");
  assert.equal(terminal.cursor, first.cursor);
});

test("step fixtures link parents, keep doc refs on the step, and cap display activity", async () => {
  const page = await load("vorgangsposition-page1.json");
  assert.ok(page.documents.length >= 3);
  let crossTerm = 0;
  for (const doc of page.documents) {
    assert.match(String(doc["id"]), NUMERIC_ID);
    assert.equal(doc["typ"], "Vorgangsposition");
    assert.match(String(doc["vorgang_id"]), NUMERIC_ID);
    assert.ok(["BT", "BR", "BV", "EK"].includes(String(doc["zuordnung"])));
    assert.ok(!("wahlperiode" in doc), "steps carry no electoral-term field");
    const fundstelle = doc["fundstelle"] as Record<string, unknown>;
    for (const key of ["id", "dokumentnummer", "pdf_url", "datum"])
      assert.ok(fundstelle[key], `fundstelle.${key} retained on the step`);
    const shown = (doc["aktivitaet_anzeige"] as unknown[] | undefined) ?? [];
    assert.ok(shown.length <= 4, "display list is limited to four");
  }
  const ids = new Set(
    (await load("vorgang-page1.json")).documents.map((d) => String(d["id"])),
  );
  for (const doc of page.documents)
    if (!ids.has(String(doc["vorgang_id"]))) crossTerm++;
  assert.ok(crossTerm > 0, "fixture must include steps outside the parent set");
});

test("step content changes when extra document metadata changes", async () => {
  const original = (await load("vorgangsposition-page1.json")).documents[0];
  assert.ok(original);
  const changed = {
    ...original,
    fundstelle: {
      ...(original["fundstelle"] as Record<string, unknown>),
      herausgeber: "Changed issuer",
    },
  };
  const first = toStoredStep(original, 0);
  const second = toStoredStep(changed, 0);
  assert.ok(!("error" in first));
  assert.ok(!("error" in second));
  assert.notEqual(
    stepContentHash(first.doc, first.raw, first.fundstelleRest),
    stepContentHash(second.doc, second.raw, second.fundstelleRest),
  );
});
