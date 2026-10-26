import assert from "node:assert/strict";
import { test } from "node:test";
import { berlinHour, parseElectoralTerms } from "../src/dip/schedule.js";

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
