import { database } from "../../../../src/db";
import { requestDocument } from "../../../../src/dip/documents/process";

// On-demand document request: metadata and the original pdf_url return at once.
// An unprocessed document is queued for PDF processing at high priority.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ referenceId: string }> },
) {
  const { referenceId } = await params;
  return documentResponse(referenceId);
}

// The same request as an explicit write, for a UI action that queues one
// document rather than reading its metadata. A state-changing request must come
// from this page, like the brief tester.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ referenceId: string }> },
) {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (
    !host ||
    (origin !== `http://${host}` && origin !== `https://${host}`) ||
    !request.headers.get("content-type")?.startsWith("application/json")
  )
    return Response.json(
      { error: "Local page request required." },
      { status: 403 },
    );
  const { referenceId } = await params;
  return documentResponse(referenceId);
}

async function documentResponse(referenceId: string) {
  if (!/^\d+$/.test(referenceId))
    return Response.json(
      { error: "Document reference ID must be numeric" },
      { status: 400 },
    );
  const prisma = database();
  try {
    const document = await requestDocument(prisma, referenceId);
    if (!document)
      return Response.json(
        { error: "Document reference not found" },
        { status: 404 },
      );
    return Response.json(document);
  } catch (error) {
    return Response.json(
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
