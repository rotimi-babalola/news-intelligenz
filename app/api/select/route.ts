import { z } from "zod";
import { database } from "../../../src/db";
import {
  MAX_BRIEF_QUESTION_LENGTH,
  PROCEEDING_SELECTION_LIMIT,
} from "../../../src/dip/constants";
import type { Dossier } from "../../../src/dip/explain/types";
import { searchProceedingDossiers } from "../../../src/dip/search/dossiers";
import { selectProceeding } from "../../../src/dip/search/selection";
import { isLocalPageRequest } from "../local-page";

const bodySchema = z.object({
  question: z.string().trim().min(1).max(MAX_BRIEF_QUESTION_LENGTH),
});

type ErrorCode =
  | "forbidden"
  | "invalid_request"
  | "no_match"
  | "proceeding_missing"
  | "search_failed";

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

  const { question } = parsed.data;
  let prisma: ReturnType<typeof database> | undefined;
  try {
    prisma = database();
    const dossiers = await searchProceedingDossiers(
      prisma,
      question,
      PROCEEDING_SELECTION_LIMIT,
    );
    const selection = selectProceeding(dossiers, question);
    if (selection.kind === "selected")
      return Response.json({
        kind: "selected",
        proceeding: candidateSummary(selection.dossier),
      });

    if (!selection.dossiers.length) {
      // An orphan timeline matched, but no proceeding can be explained.
      if (dossiers.some((dossier) => dossier.parentMissing))
        return failure(
          "proceeding_missing",
          "The proceeding record for this timeline is missing; no explainer can be offered.",
          404,
        );
      return failure("no_match", "No proceeding matched this question.", 404);
    }

    return Response.json({
      kind: "candidates",
      candidates: selection.dossiers.map(candidateSummary),
    });
  } catch (cause) {
    return failure(
      "search_failed",
      cause instanceof Error ? cause.message : "Search failed.",
      500,
    );
  } finally {
    await prisma?.$disconnect();
  }
}
