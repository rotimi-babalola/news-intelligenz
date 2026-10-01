import { NextResponse } from "next/server";
import { z } from "zod";
import { database } from "../../../src/db";
import { collectAll } from "../../../src/import/service";
import { runPrefixSchema } from "../../../src/validation";

const bodySchema = z.object({ runPrefix: runPrefixSchema });

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
    return NextResponse.json(await collectAll(prisma, parsed.data.runPrefix));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Collection failed" },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
