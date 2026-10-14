import { NextResponse } from "next/server";
import { database } from "../../../src/db";
import { processNextProceedingEmbedding } from "../../../src/dip/embedding";

export async function POST() {
  const prisma = database();
  try {
    return NextResponse.json(
      await processNextProceedingEmbedding(prisma, "api-drain-dip"),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "DIP drain failed" },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
