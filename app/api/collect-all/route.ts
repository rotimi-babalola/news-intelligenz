import { NextResponse } from "next/server";
import { database } from "../../../src/db";
import { collectAll } from "../../../src/import/service";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const runPrefix = typeof body?.runPrefix === "string" ? body.runPrefix : "";
  if (!runPrefix) {
    return NextResponse.json(
      { error: "runPrefix is required" },
      { status: 400 },
    );
  }
  const prisma = database();
  try {
    return NextResponse.json(await collectAll(prisma, runPrefix));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Collection failed" },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
