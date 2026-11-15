import { createHash } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import { BRIEF_CACHE_VERSION, MAX_BRIEF_QUESTION_LENGTH } from "../constants";
import {
  findProceedingBrief,
  latestDocumentContent,
  saveProceedingBrief,
} from "../db/index";
import { isCurrentDocumentVariant } from "../documents/citation";
import { getProceeding } from "../proceedings/timeline";
import { buildBrief } from "./brief";
import {
  alignDocumentClaims,
  emptyClaims,
  latestStageClaim,
  orderedStepClaims,
} from "./claims";
import { validateAnswer } from "./citations";
import { collectEvidence, matchesDossier } from "./evidence";
import {
  generateAnswer,
  translatePages,
  verifyClaims,
  type Generate,
  type Translate,
  type Verify,
} from "./provider";
import type { BriefLanguage, Dossier } from "./types";

export async function generateProceedingBrief(
  prisma: PrismaClient,
  question: string,
  language: BriefLanguage,
  dossier: Dossier,
  generate: Generate = generateAnswer,
  verify: Verify = verifyClaims,
  translate: Translate = translatePages,
) {
  if (!question.trim() || question.length > MAX_BRIEF_QUESTION_LENGTH)
    throw new Error("Question must contain 1–1000 characters");
  if (language !== "en" && language !== "de")
    throw new Error("Unsupported language");
  const current = await getProceeding(prisma, dossier.apiId);
  if (!current || !matchesDossier(current, dossier))
    throw new Error("Dossier changed; search again before generating a brief");

  const { evidence, documentVersions } = await collectEvidence(
    prisma,
    current,
    dossier,
  );
  const model =
    generate === generateAnswer
      ? `${process.env.EXPLAIN_BASE_URL || "https://api.openai.com/v1"}:${process.env.EXPLAIN_MODEL || ""}`
      : "injected";
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        BRIEF_CACHE_VERSION,
        question.trim(),
        language,
        model,
        dossier.apiId,
        current.proceeding?.versionNo,
        current.steps.map((step) => [
          step.apiId,
          step.versionNo,
          step.document?.referenceId,
          step.document?.pdfUrl,
        ]),
        documentVersions,
        evidence.map(({ id, text }) => [id, text]),
      ]),
    )
    .digest("hex");
  const cached = await findProceedingBrief(prisma, key);
  if (cached)
    return {
      ...(cached.answer as ReturnType<typeof buildBrief>),
      retrievalRelevance: dossier.ranking.strongestEvidence,
    };
  const claims = evidence.length
    ? await validateAnswer(
        await generate({ question: question.trim(), language, evidence }),
        evidence,
        language,
        verify,
      )
    : emptyClaims();
  claims.stage = latestStageClaim(current.steps, claims.stage, language);
  claims.steps = orderedStepClaims(current.steps, claims.steps, language);
  claims.documents = await alignDocumentClaims(
    evidence,
    claims.documents,
    language,
    translate,
  );
  const latest = await getProceeding(prisma, dossier.apiId);
  if (!latest || !matchesDossier(latest, dossier))
    throw new Error("Dossier changed during generation; search again");
  for (const [referenceId, byteHash, pdfUrl] of documentVersions) {
    const variant = await latestDocumentContent(prisma, referenceId);
    if (
      !variant ||
      variant.byteHash !== byteHash ||
      !isCurrentDocumentVariant(variant.requestedUrl, pdfUrl)
    )
      throw new Error("Document changed during generation; search again");
  }
  const answer = buildBrief(dossier, language, question.trim(), claims);
  await saveProceedingBrief(prisma, key, dossier.apiId, language, answer);
  return answer;
}
