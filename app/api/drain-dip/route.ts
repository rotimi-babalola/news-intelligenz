import { NextResponse } from "next/server";
import { database } from "../../../src/db";
import { processNextDipEmbedding } from "../../../src/dip/embedding";

export async function POST() {
  const prisma = database();
  try {
    return NextResponse.json(
      await processNextDipEmbedding(prisma, "api-drain-dip"),
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
