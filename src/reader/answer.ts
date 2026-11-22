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
  // The generator may repeat the lead claim in matter or stage; show it once.
  const seen = new Set<string>();
  const toReaderClaims = (claims: Claim[]) =>
    claims.flatMap((claim) => {
      const key = `${claim.text}\u0000${claim.citation.url}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [toReaderClaim(claim, language)];
    });
  const direct = [
    ...brief.claims.answer,
    ...brief.claims.matter,
    ...brief.claims.stage,
  ];
  const steps = brief.claims.steps;
  const timelineSteps =
    new Set(steps.map((claim) => claim.citation.stepId)).size > 1 ? steps : [];
  // Steps that cannot form a timeline stay in the answer: with no direct
  // answer they are the short answer, otherwise they are context.
  const looseSteps = timelineSteps.length ? [] : steps;
  const shortAnswer = toReaderClaims([
    ...direct,
    ...(direct.length ? [] : looseSteps),
  ]);
  const context = toReaderClaims([
    ...brief.claims.documents,
    ...brief.claims.unresolved,
    ...(direct.length ? looseSteps : []),
  ]);
  const timeline = toReaderClaims(timelineSteps);
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
