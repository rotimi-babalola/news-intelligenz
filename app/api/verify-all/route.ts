import { NextResponse } from "next/server";
import { verifyAllFeeds } from "../../../src/import/service";

export async function GET() {
  try {
    return NextResponse.json(await verifyAllFeeds());
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Verification failed",
      },
      { status: 500 },
    );
  }
}
