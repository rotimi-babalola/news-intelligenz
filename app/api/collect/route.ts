import { NextResponse } from "next/server";
import { database } from "../../../src/db";
import { collect } from "../../../src/import/service";
import { configuredFeed, customFeed, fetchFeedXml } from "../../../src/sources";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const runId = typeof body?.runId === "string" ? body.runId : "";
  if (!runId) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }
  const prisma = database();
  try {
    const feed =
      typeof body?.feedUrl === "string" && body.feedUrl
        ? customFeed(body.feedUrl)
        : configuredFeed;
    const xml = await fetchFeedXml(feed.url!);
    return NextResponse.json(await collect(prisma, runId, xml, feed));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Collection failed" },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
