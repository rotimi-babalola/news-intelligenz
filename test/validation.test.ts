import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feedUrlSchema,
  jobIdSchema,
  runIdSchema,
  runPrefixSchema,
} from "../src/validation.js";

test("run IDs accept 1–200 characters", () => {
  assert.equal(runIdSchema.parse("f001"), "f001");
  assert.equal(runIdSchema.parse("  f001  "), "f001");
  assert.ok(!runIdSchema.safeParse("").success);
  assert.ok(!runIdSchema.safeParse("   ").success);
  assert.ok(!runIdSchema.safeParse("x".repeat(201)).success);
  assert.ok(!runIdSchema.safeParse(42).success);
});

test("run prefixes accept 1–100 characters", () => {
  assert.equal(runPrefixSchema.parse("qa"), "qa");
  assert.ok(!runPrefixSchema.safeParse("").success);
  assert.ok(!runPrefixSchema.safeParse("x".repeat(101)).success);
});

test("feed URLs accept empty, undefined, and HTTP(S) URLs", () => {
  assert.equal(feedUrlSchema.parse(undefined), undefined);
  assert.equal(feedUrlSchema.parse(""), "");
  assert.equal(
    feedUrlSchema.parse("https://www.deutschlandfunk.de/nachrichten-100.rss"),
    "https://www.deutschlandfunk.de/nachrichten-100.rss",
  );
  assert.ok(!feedUrlSchema.safeParse("not-a-url").success);
  assert.ok(!feedUrlSchema.safeParse("ftp://example.org/feed").success);
});

test("job IDs require a UUID", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(jobIdSchema.parse(id), id);
  assert.ok(!jobIdSchema.safeParse("").success);
  assert.ok(!jobIdSchema.safeParse("not-a-uuid").success);
});
