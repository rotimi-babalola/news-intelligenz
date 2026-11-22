import {
  sections,
  type AnswerConfidence,
  type BriefLanguage,
  type Claims,
  type Dossier,
} from "./types";

export function buildBrief(
  dossier: Dossier,
  language: BriefLanguage,
  question: string,
  claims: Claims,
  missing: string[],
) {
  const answered = sections.filter(
    (section) => claims[section].length > 0,
  ).length;
  const answerConfidence: AnswerConfidence =
    answered === 0
      ? "abstain"
      : answered === sections.length && missing.length === 0
        ? "supported"
        : "partial";
  const missingStatement =
    missing.length > 0
      ? language === "en"
        ? `The stored evidence does not contain the requested facts: ${missing.join("; ")}.`
        : `Die gespeicherten Belege enthalten die gefragten Angaben nicht: ${missing.join("; ")}.`
      : null;
  return {
    proceedingApiId: dossier.apiId,
    question,
    language,
    answerConfidence,
    retrievalRelevance: dossier.ranking.strongestEvidence,
    claims,
    qualification:
      missingStatement ??
      (answerConfidence === "supported"
        ? null
        : answerConfidence === "abstain"
          ? language === "en"
            ? "The stored evidence does not answer this question."
            : "Die gespeicherten Belege beantworten diese Frage nicht."
          : language === "en"
            ? "The stored evidence does not establish every part of the answer."
            : "Die gespeicherten Belege klären nicht alle Teile der Antwort."),
  };
}
