import { NextResponse } from "next/server";
import { z } from "zod";
import { database } from "../../../src/db";
import { searchDip } from "../../../src/dip/search";

const bodySchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.number().int().min(1).max(20).default(10),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  const prisma = database();
  try {
    return NextResponse.json({
      results: await searchDip(prisma, parsed.data.query, parsed.data.limit),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "DIP search failed" },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
