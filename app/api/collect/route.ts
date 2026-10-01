import { NextResponse } from "next/server";
import { z } from "zod";
import { database } from "../../../src/db";
import { collect } from "../../../src/import/service";
import { configuredFeed, customFeed, fetchFeedXml } from "../../../src/sources";
import { feedUrlSchema, runIdSchema } from "../../../src/validation";

const bodySchema = z.object({ runId: runIdSchema, feedUrl: feedUrlSchema });

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
    const feed = parsed.data.feedUrl
      ? customFeed(parsed.data.feedUrl)
      : configuredFeed;
    const xml = await fetchFeedXml(feed.url!);
    return NextResponse.json(
      await collect(prisma, parsed.data.runId, xml, feed),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Collection failed" },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
