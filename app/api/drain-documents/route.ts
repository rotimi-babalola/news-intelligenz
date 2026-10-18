import { NextResponse } from "next/server";
import { database } from "../../../src/db";
import { processNextDocument } from "../../../src/dip/documents";

export async function POST() {
  const prisma = database();
  try {
    return NextResponse.json(
      await processNextDocument(prisma, "api-drain-documents"),
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Document drain failed",
      },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
