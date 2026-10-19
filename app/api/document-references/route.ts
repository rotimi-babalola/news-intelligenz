import { NextResponse } from "next/server";
import { database } from "../../../src/db";

export async function GET() {
  const prisma = database();
  try {
    const refs = await prisma.documentReference.findMany({
      where: {
        pdfUrl: { not: null },
        documentDate: { gt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
      },
      distinct: ["referenceId"],
      orderBy: { documentDate: "desc" },
      take: 20,
      select: {
        stepApiId: true,
        referenceId: true,
        documentNumber: true,
        pdfUrl: true,
        documentDate: true,
      },
    });
    return NextResponse.json({ refs });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Query failed" },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
