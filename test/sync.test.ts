import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSyncWindow, SYNC_OVERLAP_MS } from "../src/dip/sync.js";

test("null checkpoint imports baseline without a start filter", () => {
  const now = new Date("2026-10-11T07:00:00+02:00");
  const window = resolveSyncWindow(null, now);
  assert.equal(window.start, undefined);
  assert.deepEqual(window.end, now);
  assert.notEqual(window.end, now);
});

test("existing checkpoint resumes six hours before progress", () => {
  const checkpoint = new Date("2026-10-10T22:00:00.000Z");
  const now = new Date("2026-10-11T05:00:00.000Z");
  const window = resolveSyncWindow(checkpoint, now);
  assert.equal(
    window.start?.toISOString(),
    new Date(checkpoint.getTime() - SYNC_OVERLAP_MS).toISOString(),
  );
  assert.deepEqual(window.end, now);
});

test("window bounds serialize with explicit timezone offsets", () => {
  const window = resolveSyncWindow(
    new Date("2026-10-10T22:00:00.000Z"),
    new Date("2026-10-11T05:00:00.000Z"),
  );
  // toISOString always carries an explicit offset (Z); callers pass Dates and
  // fetchers send these strings as f.aktualisiert.start/end, never bare local
  // times.
  assert.match(window.start?.toISOString() ?? "", /Z$/);
  assert.match(window.end.toISOString(), /Z$/);
});
