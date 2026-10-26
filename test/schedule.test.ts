import assert from "node:assert/strict";
import { test } from "node:test";
import {
  berlinHour,
  defaultRunId,
  isDue,
  parseBackfillWindow,
  parseElectoralTerms,
  parseProceedingCap,
  parseRunHour,
} from "../src/dip/schedule.js";

test("default terms collect 21 then 20", () => {
  assert.deepEqual(parseElectoralTerms(undefined), [21, 20]);
  assert.deepEqual(parseElectoralTerms("  "), [21, 20]);
});

test("terms parse in order, trimmed and deduplicated", () => {
  assert.deepEqual(parseElectoralTerms("19, 21 ,20,21"), [19, 21, 20]);
});

test("terms outside the DIP range fail loudly", () => {
  for (const raw of ["21,", "0", "31", "21,x", "21.5"])
    assert.throws(() => parseElectoralTerms(raw), /electoral terms 1-30/);
});

test("Berlin hour selects one of the two UTC cron triggers across DST", () => {
  const summerMorning = new Date("2026-07-01T05:00:00Z"); // CEST = 07:00
  const summerLater = new Date("2026-07-01T06:00:00Z"); // CEST = 08:00
  const winterMorning = new Date("2026-12-01T06:00:00Z"); // CET = 07:00
  const winterEarlier = new Date("2026-12-01T05:00:00Z"); // CET = 06:00
  assert.equal(berlinHour(summerMorning), 7);
  assert.equal(berlinHour(summerLater), 8);
  assert.equal(berlinHour(winterMorning), 7);
  assert.equal(berlinHour(winterEarlier), 6);
  assert.equal(berlinHour(new Date("2026-12-01T23:30:00Z")), 0);
});

test("run hour is optional but a typo fails instead of skipping forever", () => {
  assert.equal(parseRunHour(undefined), null);
  assert.equal(parseRunHour("  "), null);
  assert.equal(parseRunHour("7"), 7);
  assert.equal(parseRunHour(" 0 "), 0);
  for (const raw of ["24", "-1", "7.5", "seven"])
    assert.throws(() => parseRunHour(raw), /DIP_RUN_HOUR must be an hour/);
});

test("due check accepts every trigger when no hour is configured", () => {
  const now = new Date("2026-10-26T06:00:00Z"); // CET = 07:00
  assert.equal(isDue(now, null), true);
  assert.equal(isDue(now, 7), true);
  assert.equal(isDue(now, 6), false);
});

test("run ids are unique per invocation, not per day", () => {
  const first = defaultRunId(new Date("2026-10-26T06:00:00.000Z"));
  const later = defaultRunId(new Date("2026-10-26T06:00:00.001Z"));
  assert.equal(first, "dip-20261026T060000000Z");
  assert.notEqual(first, later);
});

test("backfill window parses both ends and defaults the end to now", () => {
  const now = new Date("2026-10-26T06:00:00Z");
  assert.equal(parseBackfillWindow(undefined, undefined, now), undefined);
  assert.deepEqual(
    parseBackfillWindow("2026-10-01T00:00:00Z", undefined, now),
    { start: new Date("2026-10-01T00:00:00Z"), end: now },
  );
  assert.deepEqual(
    parseBackfillWindow("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", now),
    {
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-10-02T00:00:00Z"),
    },
  );
  assert.throws(
    () => parseBackfillWindow("not-a-date", undefined, now),
    /DIP_BACKFILL_FROM must be a valid date/,
  );
  assert.throws(
    () =>
      parseBackfillWindow("2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z", now),
    /must be before/,
  );
});

test("proceeding cap is optional and must be positive", () => {
  assert.equal(parseProceedingCap(undefined), undefined);
  assert.equal(parseProceedingCap(""), undefined);
  assert.equal(parseProceedingCap("1000"), 1000);
  for (const raw of ["0", "-1", "1.5", "many"])
    assert.throws(() => parseProceedingCap(raw), /positive integer/);
});
