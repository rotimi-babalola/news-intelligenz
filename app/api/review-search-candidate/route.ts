import { NextResponse } from "next/server";
import { z } from "zod";
import { database } from "../../../src/db";
import { reviewSearchCandidate } from "../../../src/import/service";
import { runIdSchema } from "../../../src/validation";

const bodySchema = z.object({
  runId: runIdSchema,
  itemIndex: z.number().int().min(0),
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string().trim().min(1).max(2000),
});

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
    const review = await reviewSearchCandidate(
      prisma,
      parsed.data.runId,
      parsed.data.itemIndex,
      parsed.data.decision,
      parsed.data.reason,
    );
    return NextResponse.json(review);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Review failed" },
      { status: 400 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
