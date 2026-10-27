import assert from "node:assert/strict";
import { test } from "node:test";
import { splitDocumentPage } from "../src/dip/chunks.js";

test("PDF passages are bounded, overlapping, and deterministic", async () => {
  const text = `${"First topic. ".repeat(110)}\n\n${"Second topic. ".repeat(110)}`;
  const chunks = await splitDocumentPage(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1200));
  assert.deepEqual(chunks, await splitDocumentPage(text));
  assert.ok(chunks[0]!.includes("First topic."));
  assert.ok(chunks.at(-1)!.includes("Second topic."));
  assert.deepEqual(await splitDocumentPage("  \n  "), []);
});
