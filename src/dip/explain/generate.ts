import { createHash } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  BRIEF_ASSEMBLY_VERSION,
  MAX_BRIEF_QUESTION_LENGTH,
} from "../constants";
import {
  findProceedingBrief,
  latestDocumentContent,
  latestDocumentContents,
  saveProceedingBrief,
} from "../db/index";
import { isCurrentDocumentVariant } from "../documents/citation";
import { getProceeding } from "../proceedings/timeline";
import { buildBrief } from "./brief";
import {
  alignDocumentClaims,
  emptyClaims,
  orderedStepClaims,
  selectedAnswerClaims,
  stepFallbackClaims,
} from "./claims";
import { missingFacts, validateAnswer } from "./citations";
import {
  citedDocumentIds,
  collectEvidence,
  matchesDossier,
  type DocumentVariants,
} from "./evidence";
import { chatCompletionsProvider, type ExplainerProvider } from "./provider";
import type { BriefLanguage, Dossier } from "./types";

type BriefRequest = {
  question: string;
  language: BriefLanguage;
  dossier: Dossier;
};

export async function generateProceedingBrief(
  prisma: PrismaClient,
  { question, language, dossier }: BriefRequest,
  provider: ExplainerProvider = chatCompletionsProvider(),
) {
  if (!question.trim() || question.length > MAX_BRIEF_QUESTION_LENGTH)
    throw new Error("Question must contain 1–1000 characters");
  if (language !== "en" && language !== "de")
    throw new Error("Unsupported language");
  // An orphan step timeline has no proceeding to explain, so it can only
  // abstain; never present those steps as an answer.
  if (dossier.parentMissing)
    return {
      ...buildBrief(dossier, language, question.trim(), emptyClaims(), []),
      qualification:
        language === "en"
          ? "The proceeding record for this timeline is missing; no explainer can be offered."
          : "Der Vorgang zu dieser Chronologie fehlt; es kann keine Erläuterung angeboten werden.",
    };
  const current = await getProceeding(prisma, dossier.apiId);
  if (!current || !matchesDossier(current, dossier))
    throw new Error("Dossier changed; search again before generating a brief");

  // The cache key is computed before evidence collection: the dossier hits and
  // the latest document hashes fully determine the evidence, so a hit can skip
  // page and chunk reads. One variant query covers every cited document.
  const documentIds = citedDocumentIds(dossier);
  const variants: DocumentVariants = documentIds.length
    ? await latestDocumentContents(prisma, documentIds)
    : [];
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        BRIEF_ASSEMBLY_VERSION,
        question.trim(),
        language,
        provider.identity,
        dossier.apiId,
        current.proceeding?.versionNo,
        current.steps.map((step) => [
          step.apiId,
          step.versionNo,
          step.document?.referenceId,
          step.document?.pdfUrl,
        ]),
        dossier.evidence.map((hit) =>
          hit.entity === "dokument"
            ? [
                hit.entity,
                hit.apiId,
                hit.versionNo,
                hit.document.referenceId,
                hit.document.pdfUrl,
                hit.page,
                hit.chunk,
                hit.passage,
              ]
            : [hit.entity, hit.apiId, hit.versionNo],
        ),
        variants.map((variant) => [
          variant.referenceId,
          variant.variantNo,
          variant.byteHash,
          variant.requestedUrl,
        ]),
      ]),
    )
    .digest("hex");
  const cached = await findProceedingBrief(prisma, key);
  if (cached)
    return {
      ...(cached.answer as ReturnType<typeof buildBrief>),
      retrievalRelevance: dossier.ranking.strongestEvidence,
    };
  const { evidence, documentVersions } = await collectEvidence(
    prisma,
    current,
    dossier,
    variants,
  );
  const generated = evidence.length
    ? await provider.generate({
        question: question.trim(),
        language,
        evidence,
      })
    : null;
  const claims = generated
    ? await validateAnswer(generated, evidence, language, provider.verify)
    : emptyClaims();
  const missing = generated ? missingFacts(generated) : [];
  const [stepFallbacks, documentClaims] = await Promise.all([
    stepFallbackClaims(
      current.steps,
      claims.matter,
      claims.stage,
      language,
      provider.translateTerms,
    ),
    alignDocumentClaims(
      evidence,
      claims.documents,
      language,
      provider.translate,
    ),
  ]);
  claims.matter = stepFallbacks.matter;
  claims.stage = stepFallbacks.stage;
  claims.steps = orderedStepClaims(current.steps, claims.steps, language);
  claims.documents = documentClaims;
  // A language's lead can be rejected while the other language answers, so an
  // empty lead is filled from this language's verified claims.
  if (!claims.answer.length && provider.selectAnswer) {
    const candidates = (["matter", "stage", "documents"] as const).flatMap(
      (section) =>
        claims[section].map((claim, index) => ({
          id: `${section}:${index}`,
          claim,
        })),
    );
    if (candidates.length)
      claims.answer = selectedAnswerClaims(
        candidates,
        await provider.selectAnswer({
          question: question.trim(),
          language,
          claims: candidates.map(({ id, claim }) => ({ id, text: claim.text })),
        }),
      );
  }
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
  const answer = buildBrief(
    dossier,
    language,
    question.trim(),
    claims,
    missing,
  );
  await saveProceedingBrief(prisma, key, dossier.apiId, language, answer);
  return answer;
}
