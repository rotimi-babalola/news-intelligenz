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
  const numbered = Array.from({ length: 650 }, (_, index) =>
    String(index).padStart(4, "0"),
  ).join(" ");
  const overlapping = await splitDocumentPage(numbered);
  assert.ok(overlapping.length > 2);
  assert.ok(overlapping[0]!.includes("0200 0201"));
  assert.ok(overlapping[1]!.startsWith("0200 0201"));
  assert.deepEqual(await splitDocumentPage("  \n  "), []);
});
