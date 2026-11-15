export type RelevanceItem = {
  entity: "vorgang" | "vorgangsposition" | "dokument";
  apiId: string;
  page?: number | null;
};

export function relevanceKey(item: RelevanceItem) {
  return `${item.entity}:${item.apiId}:${item.entity === "dokument" ? item.page : 0}`;
}

export function scoreRanking(
  relevant: RelevanceItem[],
  results: RelevanceItem[],
) {
  const expected = new Set(relevant.map(relevanceKey));
  if (!expected.size)
    throw new Error("Each query needs at least one relevance label");
  const ranked = results.map(relevanceKey);
  const recallAt = (k: number) =>
    [...expected].filter((key) => ranked.slice(0, k).includes(key)).length /
    expected.size;
  const first = ranked.findIndex((key) => expected.has(key));
  return {
    recallAt5: recallAt(5),
    recallAt10: recallAt(10),
    reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
  };
}
