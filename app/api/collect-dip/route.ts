import { NextResponse } from "next/server";
import { z } from "zod";
import { database } from "../../../src/db";
import { liveStepsFetcher } from "../../../src/dip/steps";
import { syncDipTerms } from "../../../src/dip/sync";
import {
  LOCAL_PROCEEDING_CAP,
  liveVorgangFetcher,
} from "../../../src/dip/vorgang";
import { runIdSchema } from "../../../src/validation";

const bodySchema = z.object({
  runId: runIdSchema,
  electoralTerm: z.number().int().min(1).max(30),
  source: z.literal("live"),
  proceedingCap: z.number().int().min(1).default(LOCAL_PROCEEDING_CAP),
});

// DIP data may be retained and published with the Bundestag as the source.
const ATTRIBUTION = "Source: Deutscher Bundestag (DIP)";

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
    const { runId, electoralTerm, proceedingCap } = parsed.data;
    const runIdFor = (endpoint: string, term: number) =>
      `${runId}:${endpoint}:${term}`;
    const apiKey = process.env.BUNDESTAG_API_KEY;
    if (!apiKey) throw new Error("BUNDESTAG_API_KEY is not configured");
    const steps = liveStepsFetcher(apiKey);
    const outcome = await syncDipTerms(prisma, {
      terms: [electoralTerm],
      runIdFor,
      proceedingCap,
      followStoredParents: true,
      fetchVorgangPage: liveVorgangFetcher(apiKey),
      fetchStepPage: steps.fetchPage,
      fetchVorgang: steps.fetchVorgang,
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
