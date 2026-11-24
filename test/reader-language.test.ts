import assert from "node:assert/strict";
import { test } from "node:test";
import { inferLanguage } from "../src/reader/index.js";

test("language inference is deterministic and an override wins", () => {
  assert.equal(
    inferLanguage("Welche Vorhaben sollen die Baukosten für Wohnungen senken?"),
    "de",
  );
  assert.equal(inferLanguage("Was ist der aktuelle Stand?"), "de");
  assert.equal(
    inferLanguage("What is the current stage of this proceeding?"),
    "en",
  );
  assert.equal(inferLanguage("What does this bill change?", "de"), "de");
  assert.equal(inferLanguage("Welche Vorhaben sind geplant?", "en"), "en");
});
