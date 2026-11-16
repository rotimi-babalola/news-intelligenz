import {
  sections,
  type AnswerConfidence,
  type BriefLanguage,
  type Claims,
  type Evidence,
} from "./types";

export type ExpectedFact = {
  text: string;
  terms: string[];
  evidenceIds: string[];
  quote: string;
};

export type AnswerLabel = {
  question: string;
  language: BriefLanguage;
  proceeding?: string;
  expectAbstain: boolean;
  facts: ExpectedFact[];
};

export type FailureCause = "retrieval" | "dossier" | "synthesis";

export type FactScore = ExpectedFact & {
  covered: boolean;
  cited: boolean;
  cause: FailureCause | null;
};

export type Answer = {
  answerConfidence: AnswerConfidence;
  claims: Claims;
};

const EVIDENCE_ID = /^(step:\d+|page:\d+:\d+)$/u;

export function isEvidenceId(value: string) {
  return EVIDENCE_ID.test(value);
}

export function citationEvidenceId(citation: Evidence["citation"]) {
  return citation.kind === "step"
    ? `step:${citation.stepId}`
    : `page:${citation.referenceId}:${citation.page}`;
}

// PDF extraction wraps lines, hyphenates at line breaks, and inserts soft
// hyphens, so the comparison repairs those but not wording or case.
function normalized(text: string) {
  return text
    .replace(/[\u00ad\u200b]\s*/gu, "")
    .replace(/(\p{L})-\s+/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function causeFor(
  evidenceIds: string[],
  retrieved: string[],
  collected: string[],
): FailureCause {
  if (!evidenceIds.some((id) => retrieved.includes(id))) return "retrieval";
  if (!evidenceIds.some((id) => collected.includes(id))) return "dossier";
  return "synthesis";
}

export function scoreAnswer(
  label: AnswerLabel,
  answer: Answer,
  availability: { retrieved: string[]; collected: string[] },
) {
  const claims = sections.flatMap((section) => answer.claims[section]);
  const facts: FactScore[] = label.facts.map((fact) => {
    const matching = claims.filter((claim) =>
      fact.terms.every((term) =>
        normalized(claim.text).includes(normalized(term)),
      ),
    );
    const cited = matching.some((claim) =>
      fact.evidenceIds.includes(citationEvidenceId(claim.citation)),
    );
    return {
      ...fact,
      covered: matching.length > 0,
      cited,
      cause: cited
        ? null
        : causeFor(
            fact.evidenceIds,
            availability.retrieved,
            availability.collected,
          ),
    };
  });
  const abstained = answer.answerConfidence === "abstain";
  return {
    facts,
    factualCoverage: facts.length
      ? facts.filter((fact) => fact.covered).length / facts.length
      : null,
    citationSupport: facts.length
      ? facts.filter((fact) => fact.cited).length / facts.length
      : null,
    abstained,
    correctAbstention: abstained === label.expectAbstain,
  };
}

export type ScoredAnswer = ReturnType<typeof scoreAnswer>;

export function meanScore(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length
    ? present.reduce((sum, value) => sum + value, 0) / present.length
    : null;
}
