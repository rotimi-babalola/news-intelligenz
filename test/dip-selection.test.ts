import assert from "node:assert/strict";
import { test } from "node:test";
import { PROCEEDING_SELECTION_EVIDENCE_FLOOR } from "../src/dip/constants.js";
import type { Dossier } from "../src/dip/explain/types.js";
import { selectProceeding } from "../src/dip/search/selection.js";

const dossier = (
  apiId: string,
  strongestEvidence: number,
  parentMissing = false,
) =>
  ({
    apiId,
    parentMissing,
    title: `Proceeding ${apiId}`,
    ranking: { strongestEvidence },
  }) as Dossier;

const ids = (selection: ReturnType<typeof selectProceeding>) =>
  selection.kind === "selected"
    ? [selection.dossier.apiId]
    : selection.dossiers.map((item) => item.apiId);

test("a clear, strong match is selected", () => {
  const selection = selectProceeding(
    [dossier("1", 0.8), dossier("2", 0.6)],
    "housing costs",
  );
  assert.equal(selection.kind, "selected");
  assert.deepEqual(ids(selection), ["1"]);
});

test("a near tie and a weak match both return candidates", () => {
  assert.equal(
    selectProceeding([dossier("1", 0.8), dossier("2", 0.78)], "housing").kind,
    "candidates",
  );
  assert.deepEqual(
    ids(
      selectProceeding(
        [dossier("1", PROCEEDING_SELECTION_EVIDENCE_FLOOR - 0.01)],
        "housing",
      ),
    ),
    ["1"],
  );
});

test("a stronger lower-ranked rival keeps the choice open", () => {
  const selection = selectProceeding(
    [dossier("1", 0.8), dossier("2", 0.74), dossier("3", 0.79)],
    "housing",
  );
  assert.equal(selection.kind, "candidates");
});

test("no dossiers is no match", () => {
  const selection = selectProceeding([], "housing");
  assert.equal(selection.kind, "candidates");
  assert.deepEqual(ids(selection), []);
});

test("orphan timelines never auto-select or appear as candidates", () => {
  const selection = selectProceeding(
    [dossier("orphan", 0.95, true), dossier("1", 0.8), dossier("2", 0.6)],
    "housing",
  );
  assert.equal(selection.kind, "selected");
  assert.deepEqual(ids(selection), ["1"]);
  assert.deepEqual(
    ids(selectProceeding([dossier("orphan", 0.95, true)], "x")),
    [],
  );
});
