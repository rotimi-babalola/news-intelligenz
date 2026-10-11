import { NextResponse } from "next/server";
import { z } from "zod";
import { database } from "../../../src/db";
import { liveStepsFetcher } from "../../../src/dip/steps";
import { syncDipTerms } from "../../../src/dip/sync";
import { liveVorgangFetcher } from "../../../src/dip/vorgang";
import { runIdSchema } from "../../../src/validation";
import fixtureStepsPage from "../../../fixtures/dip/vorgangsposition-page1.json";
import fixtureVorgangPage from "../../../fixtures/dip/vorgang-page1.json";
import fixtureVorgangTerminal from "../../../fixtures/dip/vorgang-page2-terminal.json";

const bodySchema = z.object({
  runId: runIdSchema,
  electoralTerm: z.number().int().min(1).max(30),
  source: z.enum(["fixture", "live"]).default("fixture"),
});

// DIP data may be retained and published with the Bundestag as the source.
const ATTRIBUTION = "Source: Deutscher Bundestag (DIP)";

type FixturePage = {
  documents: unknown[];
  cursor: string;
  numFound: number;
};

// Repeatable fixture pages through the real sync path: first page, then a
// terminal page whose cursor stops changing. Live mode uses the same
// collector with the operational fetchers and never fetches PDF bytes.
function fixtureFetcher(first: FixturePage, rest: FixturePage) {
  const pick = (page: FixturePage) => ({
    documents: page.documents,
    cursor: page.cursor,
    numFound: page.numFound,
  });
  return async (params: {
    cursor?: string;
  }): Promise<{ documents: unknown[]; cursor: string; numFound: number }> =>
    params.cursor === undefined ? pick(first) : pick(rest);
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const prisma = database();
  try {
    const { runId, electoralTerm, source } = parsed.data;
    const runIdFor = (endpoint: string, term: number) =>
      `${runId}:${endpoint}:${term}`;
    const outcome =
      source === "live"
        ? await (async () => {
            const apiKey = process.env.BUNDESTAG_API_KEY;
            if (!apiKey) throw new Error("BUNDESTAG_API_KEY is not configured");
            const steps = liveStepsFetcher(apiKey);
            return syncDipTerms(prisma, {
              terms: [electoralTerm],
              runIdFor,
              followStoredParents: true,
              fetchVorgangPage: liveVorgangFetcher(apiKey),
              fetchStepPage: steps.fetchPage,
              fetchVorgang: steps.fetchVorgang,
            });
          })()
        : await syncDipTerms(prisma, {
            terms: [electoralTerm],
            runIdFor,
            fetchVorgangPage: fixtureFetcher(
              fixtureVorgangPage,
              fixtureVorgangTerminal,
            ),
            fetchStepPage: fixtureFetcher(fixtureStepsPage, {
              documents: [],
              cursor: fixtureStepsPage.cursor,
              numFound: fixtureStepsPage.numFound,
            }),
          });
    return NextResponse.json({ attribution: ATTRIBUTION, outcome });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Collection failed" },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
