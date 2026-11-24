import { z } from "zod";
import { database } from "../../../src/db";
import {
  MAX_BRIEF_QUESTION_LENGTH,
  PROCEEDING_SELECTION_LIMIT,
} from "../../../src/dip/constants";
import { generateProceedingBrief } from "../../../src/dip/explain/index";
import type { Dossier } from "../../../src/dip/explain/types";
import { searchProceedingDossiers } from "../../../src/dip/search/dossiers";
import { selectProceeding } from "../../../src/dip/search/selection";
import { inferLanguage, readerAnswer } from "../../../src/reader/index";
import { isLocalPageRequest } from "../local-page";

const bodySchema = z.object({
  question: z.string().trim().min(1).max(MAX_BRIEF_QUESTION_LENGTH),
  language: z.enum(["en", "de"]).optional(),
  proceedingApiId: z.string().max(20).regex(/^\d+$/).optional(),
});

type ErrorCode =
  | "forbidden"
  | "invalid_request"
  | "no_match"
  | "proceeding_missing"
  | "proceeding_not_found"
  | "generation_failed";

function failure(code: ErrorCode, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status });
}

const candidateSummary = (dossier: Dossier) => ({
  apiId: dossier.apiId,
  title: dossier.title,
  type: dossier.type,
  deliberationState: dossier.deliberationState,
  lastActivity: dossier.lastActivity,
});

const dossierSummary = (dossier: Dossier) => ({
  ...candidateSummary(dossier),
  steps: dossier.steps.map((step) => ({
    apiId: step.apiId,
    institution: step.institution,
    label: step.label,
    title: step.title,
    documentDate: step.documentDate,
  })),
});

export async function POST(request: Request) {
  if (!isLocalPageRequest(request))
    return failure("forbidden", "Local page request required.", 403);
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return failure(
      "invalid_request",
      "Enter a question of up to 1,000 characters.",
      400,
    );

  const { question, proceedingApiId } = parsed.data;
  const language = inferLanguage(question, parsed.data.language);
  const prisma = database();
  try {
    const dossiers = await searchProceedingDossiers(
      prisma,
      question,
      PROCEEDING_SELECTION_LIMIT,
    );
    let dossier: Dossier | undefined;
    // shortcut: a pinned proceeding must still rank in this search; a follow-up
    // phrased far from the record gets proceeding_not_found. Retrieve within the
    // pinned proceeding when the reader thread needs the pin to survive any
    // follow-up.
    if (proceedingApiId) {
      dossier = dossiers.find((item) => item.apiId === proceedingApiId);
      if (!dossier)
        return failure(
          "proceeding_not_found",
          `That proceeding was not among the top ${PROCEEDING_SELECTION_LIMIT} results for this question. Try a question closer to its title.`,
          404,
        );
    } else {
      const selection = selectProceeding(dossiers, question);
      if (selection.kind === "candidates") {
        if (!selection.dossiers.length) {
          // An orphan timeline matched, but no proceeding can be explained.
          if (dossiers.some((item) => item.parentMissing))
            return failure(
              "proceeding_missing",
              "The proceeding record for this timeline is missing; no explainer can be offered.",
              404,
            );
          return failure(
            "no_match",
            "No proceeding matched this question.",
            404,
          );
        }
        return Response.json({
          kind: "candidates",
          candidates: selection.dossiers.map(candidateSummary),
        });
      }
      dossier = selection.dossier;
    }

    const brief = await generateProceedingBrief(prisma, {
      question,
      language,
      dossier,
    });
    return Response.json({
      kind: "answer",
      dossier: dossierSummary(dossier),
      answer: readerAnswer(brief),
    });
  } catch (cause) {
    return failure(
      "generation_failed",
      cause instanceof Error ? cause.message : "Brief generation failed.",
      500,
    );
  } finally {
    await prisma.$disconnect();
  }
}
