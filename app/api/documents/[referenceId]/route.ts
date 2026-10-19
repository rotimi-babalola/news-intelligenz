import { NextResponse } from "next/server";
import { database } from "../../../../src/db";
import { requestDocument } from "../../../../src/dip/documents";

// On-demand document request: metadata and the original pdf_url return at once.
// An unprocessed document is queued for PDF processing at high priority.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ referenceId: string }> },
) {
  const { referenceId } = await params;
  if (!/^\d+$/.test(referenceId))
    return NextResponse.json(
      { error: "Document reference ID must be numeric" },
      { status: 400 },
    );
  const prisma = database();
  try {
    const document = await requestDocument(prisma, referenceId);
    if (!document)
      return NextResponse.json(
        { error: "Document reference not found" },
        { status: 404 },
      );
    return NextResponse.json(document);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Document request failed",
      },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
