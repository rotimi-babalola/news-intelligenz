import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyFeed } from "../../../src/import/service";
import { configuredFeed, customFeed } from "../../../src/sources";
import { feedUrlSchema } from "../../../src/validation";

const querySchema = z.object({
  feedUrl: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? undefined)
    .pipe(feedUrlSchema),
});

export async function GET(request: Request) {
  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const feed = parsed.data.feedUrl
      ? customFeed(parsed.data.feedUrl)
      : configuredFeed;
    return NextResponse.json(await verifyFeed(feed));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Verification failed",
      },
      { status: 500 },
    );
  }
}
