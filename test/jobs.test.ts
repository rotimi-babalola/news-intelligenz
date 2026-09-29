import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backoffMs,
  dipSource,
  parseRetryAfterMs,
  RateLimitedError,
  searchSource,
} from "../src/jobs.js";

test("backoff grows exponentially within the hourly cap", () => {
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(3), 120_000);
  assert.equal(backoffMs(10), 3_600_000);
  assert.equal(backoffMs(20), 3_600_000);
});

test("retry-after parsing accepts seconds, dates and rejects garbage", () => {
  assert.equal(parseRetryAfterMs("120"), 120_000);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs("not-a-delay"), null);
  const future = new Date(Date.now() + 45_000).toUTCString();
  const parsed = parseRetryAfterMs(future);
  assert.ok(parsed !== null && parsed > 0 && parsed <= 45_000);
});

test("rate-limited errors carry their delay", () => {
  const error = new RateLimitedError("HTTP 429", 90_000);
  assert.equal(error.retryAfterMs, 90_000);
  assert.match(error.message, /429/);
});

test("source constructors scope search and DIP identities", () => {
  assert.deepEqual(searchSource("Randale", ["example.org"]), {
    kind: "search_query",
    key: "Randale",
    scope: { domains: ["example.org"] },
  });
  assert.deepEqual(dipSource("/vorgang", "21"), {
    kind: "dip_endpoint",
    key: "/vorgang",
    scope: { electoralTerm: "21" },
  });
});
