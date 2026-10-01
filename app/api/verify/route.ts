import { NextResponse } from "next/server";
import { verifyFeed } from "../../../src/import/service";

export async function GET(request: Request) {
  const feedUrl = new URL(request.url).searchParams.get("feedUrl");
  try {
    return NextResponse.json(await verifyFeed(feedUrl ?? undefined));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Verification failed",
      },
      { status: 500 },
    );
  }
}
