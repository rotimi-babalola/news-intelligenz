import type { buildBrief } from "../dip/explain/brief";
import type {
  AnswerConfidence,
  BriefLanguage,
  Claim,
} from "../dip/explain/types";

export type ReaderCitation = {
  label: string;
  url: string;
};

export type ReaderClaim = {
  text: string;
  citation: ReaderCitation;
};

// The reader answer is the generated brief in reading order: the direct
// answer, optional context, an optional timeline, and the limitation.
// Categories the brief left empty are absent rather than rendered empty.
export type ReaderAnswer = {
  language: BriefLanguage;
  status: AnswerConfidence;
  shortAnswer?: ReaderClaim[];
  context?: ReaderClaim[];
  timeline?: ReaderClaim[];
  limitation: string | null;
};

type Brief = ReturnType<typeof buildBrief>;

const labels: Record<
  BriefLanguage,
  { step: string; page: (page: number | undefined) => string }
> = {
  en: {
    step: "Proceeding step",
    page: (page) =>
      page === undefined ? "Document" : `Document, page ${page}`,
  },
  de: {
    step: "Verfahrensschritt",
    page: (page) =>
      page === undefined ? "Dokument" : `Dokument, Seite ${page}`,
  },
};

function toReaderClaim(claim: Claim, language: BriefLanguage): ReaderClaim {
  const label = labels[language];
  return {
    text: claim.text,
    citation: {
      label:
        claim.citation.kind === "step"
          ? label.step
          : label.page(claim.citation.page),
      url: claim.citation.url,
    },
  };
}

export function readerAnswer(brief: Brief): ReaderAnswer {
  const language = brief.language;
  const toReaderClaims = (claims: Claim[]) =>
    claims.map((claim) => toReaderClaim(claim, language));
  const direct = [...brief.claims.matter, ...brief.claims.stage];
  const steps = brief.claims.steps;
  const directStepIds = new Set(
    direct
      .filter((claim) => claim.citation.kind === "step")
      .map((claim) => claim.citation.stepId),
  );
  // Never drop the only supported claim: a lone step with no direct answer
  // becomes the short answer instead of a one-item timeline.
  const loneStep =
    steps.length === 1 && !directStepIds.has(steps[0]!.citation.stepId)
      ? steps
      : [];
  const shortAnswer = toReaderClaims([...direct, ...loneStep]);
  const context = toReaderClaims([
    ...brief.claims.documents,
    ...brief.claims.unresolved,
  ]);
  const timeline = toReaderClaims(
    new Set(steps.map((claim) => claim.citation.stepId)).size > 1 ? steps : [],
  );
  return {
    language,
    status: brief.answerConfidence,
    ...(shortAnswer.length ? { shortAnswer } : {}),
    ...(context.length ? { context } : {}),
    // Order only earns its place once there are at least two steps to read in
    // sequence.
    ...(timeline.length ? { timeline } : {}),
    limitation: brief.qualification,
  };
}
