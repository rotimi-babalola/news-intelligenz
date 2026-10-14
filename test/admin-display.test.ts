import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDate,
  jobTone,
  paginate,
  parsePage,
  runTone,
} from "../app/admin/_components/display.js";
import { toDipCandidateView } from "../src/admin/dip.repository.js";

test("parsePage accepts positive pages and defaults the rest to 1", () => {
  assert.equal(parsePage(undefined), 1);
  assert.equal(parsePage("3"), 3);
  assert.equal(parsePage(["2"]), 2);
  assert.equal(parsePage("0"), 1);
  assert.equal(parsePage("-2"), 1);
  assert.equal(parsePage(""), 1);
  assert.equal(parsePage("abc"), 1);
});

test("paginate slices rows and reports ranges", () => {
  const items = Array.from({ length: 45 }, (_, i) => i + 1);
  const first = paginate(items, 1);
  assert.deepEqual(first.rows, items.slice(0, 20));
  assert.deepEqual(
    { page: first.page, totalPages: first.totalPages },
    { page: 1, totalPages: 3 },
  );
  assert.deepEqual(
    { from: first.from, to: first.to, total: first.total },
    { from: 1, to: 20, total: 45 },
  );
  const last = paginate(items, 3);
  assert.deepEqual(last.rows, items.slice(40, 45));
  assert.deepEqual({ from: last.from, to: last.to }, { from: 41, to: 45 });
});

test("paginate clamps out-of-range pages instead of emptying", () => {
  const items = Array.from({ length: 45 }, (_, i) => i + 1);
  assert.equal(paginate(items, 99).page, 3);
  assert.equal(paginate(items, 0).page, 1);
  assert.equal(paginate(items, -5).page, 1);
});

test("paginate handles empty and single-page lists", () => {
  const empty = paginate([], 1);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(
    { page: empty.page, totalPages: empty.totalPages },
    { page: 1, totalPages: 1 },
  );
  assert.deepEqual(
    { from: empty.from, to: empty.to, total: empty.total },
    { from: 0, to: 0, total: 0 },
  );
  const single = paginate([1, 2], 1);
  assert.equal(single.totalPages, 1);
  assert.deepEqual(single.rows, [1, 2]);
});

test("runTone maps run statuses to badge variants", () => {
  assert.equal(runTone("completed"), "success");
  assert.equal(runTone("OK"), "success");
  assert.equal(runTone("complete"), "success");
  assert.equal(runTone("failed"), "destructive");
  assert.equal(runTone("Failed"), "destructive");
  assert.equal(runTone("fetch-failure"), "destructive");
  assert.equal(runTone("pending"), "warning");
  assert.equal(runTone("retrying"), "warning");
  assert.equal(runTone("exhausted"), "warning");
});

test("jobTone maps job states to badge variants", () => {
  assert.equal(jobTone("pending"), "secondary");
  assert.equal(jobTone("claimed"), "secondary");
  assert.equal(jobTone("retrying"), "warning");
  assert.equal(jobTone("exhausted"), "destructive");
  assert.equal(jobTone("succeeded"), "success");
});

test("formatDate renders compact UTC timestamps", () => {
  assert.equal(formatDate(null), "Unknown");
  assert.equal(
    formatDate(new Date("2026-09-18T09:00:00Z")),
    "2026-09-18 09:00 UTC",
  );
});

test("DIP candidates resolve titles from stored records, never Unknown", () => {
  const proceedings = new Map([
    [
      "123",
      {
        apiId: "123",
        title: "Wohngeldreform",
        proceedingType: "Gesetzgebung",
        electoralTerm: 20,
      },
    ],
  ]);
  const steps = new Map([
    [
      "456",
      {
        apiId: "456",
        title: "Erste Beratung",
        institution: "BT",
        stepLabel: "1. Beratung",
        documentType: "Plenarprotokoll",
        proceedingApiId: "123",
      },
    ],
  ]);
  const row = (metadata: unknown, itemIndex = 0) => ({
    runId: "run-1",
    itemIndex,
    errors: [],
    metadata,
  });
  assert.deepEqual(
    toDipCandidateView(
      row({ endpoint: "/vorgang", id: "123" }),
      proceedings,
      steps,
    ),
    {
      runId: "run-1",
      itemIndex: 0,
      errors: [],
      metadata: { endpoint: "/vorgang", id: "123" },
      endpoint: "/vorgang",
      apiId: "123",
      kind: "vorgang",
      title: "Wohngeldreform",
      subtitle: "Gesetzgebung · WP 20",
    },
  );
  const step = toDipCandidateView(
    row({ endpoint: "/vorgangsposition", id: "456" }, 1),
    proceedings,
    steps,
  );
  assert.equal(step.kind, "vorgangsposition");
  assert.equal(step.title, "Erste Beratung");
  assert.equal(
    step.subtitle,
    "BT · 1. Beratung · Plenarprotokoll · Vorgang 123",
  );
});

test("DIP candidates fall back to endpoint and API ID when unstored", () => {
  const emptyProceedings = new Map();
  const emptySteps = new Map();
  const row = (metadata: unknown) => ({
    runId: "run-1",
    itemIndex: 0,
    errors: ["bad datum"],
    metadata,
  });
  const capped = toDipCandidateView(
    row({ endpoint: "/vorgang", id: "999" }),
    emptyProceedings,
    emptySteps,
  );
  assert.equal(capped.title, "Vorgang 999");
  assert.equal(capped.subtitle, "Not stored (invalid or capped)");
  const orphanStep = toDipCandidateView(
    row({ endpoint: "/vorgangsposition", id: "888" }),
    emptyProceedings,
    emptySteps,
  );
  assert.equal(orphanStep.title, "Vorgangsposition 888");
  assert.equal(
    orphanStep.subtitle,
    "Not stored (invalid or unresolved parent)",
  );
  const malformed = toDipCandidateView(
    row({ headline: "news-shaped" }),
    emptyProceedings,
    emptySteps,
  );
  assert.equal(malformed.kind, "unknown");
  assert.equal(malformed.title, "Unidentified candidate");
  assert.equal(malformed.subtitle, "No endpoint metadata");
  const noMetadata = toDipCandidateView(
    { runId: "run-1", itemIndex: 2, errors: [], metadata: null },
    emptyProceedings,
    emptySteps,
  );
  assert.equal(noMetadata.apiId, null);
  assert.equal(noMetadata.title, "Unidentified candidate");
});
