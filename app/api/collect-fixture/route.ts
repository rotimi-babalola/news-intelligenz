import { NextResponse } from "next/server";
import { database } from "../../../src/db";
import { collectFixtureRun } from "../../../src/import/service";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const runId = typeof body?.runId === "string" ? body.runId : "";
  if (!runId) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }
  const prisma = database();
  try {
    return NextResponse.json(await collectFixtureRun(prisma, runId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Collection failed" },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
