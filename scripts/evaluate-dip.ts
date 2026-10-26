import { readFile } from "node:fs/promises";
import { z } from "zod";
import { database } from "../src/db.js";
import { embeddingConfig, embeddingCost } from "../src/dip/embedding.js";
import { scoreRanking } from "../src/dip/evaluate.js";
import { searchDip } from "../src/dip/search.js";

const item = z
  .object({
    entity: z.enum(["vorgang", "vorgangsposition", "dokument"]),
    apiId: z.string().min(1),
    page: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.entity === "dokument" && !value.page)
      ctx.addIssue({ code: "custom", message: "Document labels need a page" });
  });
const labels = z.object({
  reviewed: z.literal(true),
  cases: z
    .array(
      z.object({
        query: z.string().min(1),
        relevant: z.array(item).min(1),
      }),
    )
    .min(1),
});

const path = process.argv[2];
if (!path) throw new Error("Usage: pnpm evaluate:dip -- path/to/labels.json");
const { cases } = labels.parse(JSON.parse(await readFile(path, "utf8")));
const prisma = database();
try {
  const details: Array<
    ReturnType<typeof scoreRanking> & {
      query: string;
      latencyMs: number;
      topResults: {
        entity: string;
        apiId: string;
        page?: number | null;
        score: number;
      }[];
    }
  > = [];
  for (const entry of cases) {
    const started = performance.now();
    const results = await searchDip(prisma, entry.query, 10);
    details.push({
      query: entry.query,
      ...scoreRanking(entry.relevant, results),
      latencyMs: Math.round(performance.now() - started),
      topResults: results.map(({ entity, apiId, score, ...rest }) => ({
        entity,
        apiId,
        page: "page" in rest ? rest.page : undefined,
        score,
      })),
    });
  }
  const mean = (
    field: "recallAt5" | "recallAt10" | "reciprocalRank" | "latencyMs",
  ) => details.reduce((sum, row) => sum + row[field], 0) / details.length;
  console.log(
    JSON.stringify(
      {
        model: embeddingConfig().indexId,
        queries: details.length,
        recallAt5: mean("recallAt5"),
        recallAt10: mean("recallAt10"),
        mrrAt10: mean("reciprocalRank"),
        meanLatencyMs: mean("latencyMs"),
        ...embeddingCost(),
        details,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
