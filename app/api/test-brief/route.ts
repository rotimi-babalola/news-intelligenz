import { z } from "zod";
import { database } from "../../../src/db";
import { searchProceedingDossiers } from "../../../src/dip/search/dossiers";
import { getDocumentPages } from "../../../src/dip/documents/pages";
import { generateProceedingBrief } from "../../../src/dip/explain/index";
import { isLocalPageRequest } from "../local-page";

const bodySchema = z.object({
  question: z.string().trim().min(1).max(1000),
  apiId: z.string().max(20).regex(/^\d+$/).optional(),
});

export async function POST(request: Request) {
  if (!isLocalPageRequest(request))
    return Response.json(
      { error: "Local page request required." },
      { status: 403 },
    );
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "Enter a question of up to 1,000 characters." },
      { status: 400 },
    );

  const prisma = database();
  try {
    const dossiers = await searchProceedingDossiers(
      prisma,
      parsed.data.question,
      20,
    );
    if (!dossiers.length)
      return Response.json(
        { error: "No proceeding matched this question." },
        { status: 404 },
      );
    if (!parsed.data.apiId)
      return Response.json({
        candidates: dossiers.map((item) => ({
          apiId: item.apiId,
          title: item.title,
          score: item.score,
        })),
      });
    const dossier = dossiers.find((item) => item.apiId === parsed.data.apiId);
    if (!dossier)
      return Response.json(
        {
          error:
            "That proceeding was not among the top 20 results. Try a question closer to its title.",
        },
        { status: 404 },
      );

    const [en, de] = await Promise.all([
      generateProceedingBrief(prisma, {
        question: parsed.data.question,
        language: "en",
        dossier,
      }),
      generateProceedingBrief(prisma, {
        question: parsed.data.question,
        language: "de",
        dossier,
      }),
    ]);
    const documents = await Promise.all(
      dossier.steps.flatMap((step) => {
        const document = step.document;
        if (!document) return [];
        return [
          getDocumentPages(prisma, document.referenceId, 1, 1).then(
            (pages) => ({
              stepId: step.apiId,
              referenceId: document.referenceId,
              number: document.number,
              pdfUrl: document.pdfUrl,
              status: pages.status,
              reason:
                pages.status === "metadata-only"
                  ? (pages.eligibility?.reason ?? null)
                  : null,
              retrieved: dossier.evidence.some(
                (hit) =>
                  hit.entity === "dokument" &&
                  hit.document.referenceId === document.referenceId,
              ),
            }),
          ),
        ];
      }),
    );
    return Response.json({
      selected: { apiId: dossier.apiId, title: dossier.title },
      briefs: { en, de },
      documents,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Brief generation failed.",
      },
      { status: 500 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
