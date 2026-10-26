import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreRanking } from "../src/dip/evaluate.js";

test("ranking scores current evidence identities including document pages", () => {
  const relevant = [
    { entity: "vorgang" as const, apiId: "1" },
    { entity: "dokument" as const, apiId: "2", page: 3 },
  ];
  const results = [
    { entity: "dokument" as const, apiId: "2", page: 2 },
    { entity: "dokument" as const, apiId: "2", page: 3 },
    { entity: "vorgang" as const, apiId: "1" },
  ];
  assert.deepEqual(scoreRanking(relevant, results), {
    recallAt5: 1,
    recallAt10: 1,
    reciprocalRank: 0.5,
  });
  assert.throws(() => scoreRanking([], results), /relevance label/);
});
