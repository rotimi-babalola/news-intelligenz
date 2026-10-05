import { NextResponse } from "next/server";
import { z } from "zod";
import { database } from "../../../src/db";
import { drainOpenJobs } from "../../../src/import/service";
import { runIdSchema } from "../../../src/validation";

const bodySchema = z.object({ runId: runIdSchema.optional() });

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
    return NextResponse.json(
      await drainOpenJobs(prisma, "api-drain", parsed.data.runId),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Drain failed" },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
