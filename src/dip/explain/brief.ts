import {
  sections,
  type BriefLanguage,
  type Claims,
  type Dossier,
} from "./types";

export function buildBrief(
  dossier: Dossier,
  language: BriefLanguage,
  question: string,
  claims: Claims,
) {
  const answered = sections.filter(
    (section) => claims[section].length > 0,
  ).length;
  return {
    proceedingApiId: dossier.apiId,
    question,
    language,
    answerConfidence:
      answered === 0
        ? "abstain"
        : answered === sections.length
          ? "supported"
          : "partial",
    retrievalRelevance: dossier.ranking.strongestEvidence,
    claims,
    qualification:
      answered === sections.length
        ? null
        : language === "en"
          ? "The stored evidence does not establish every part of the answer."
          : "Die gespeicherten Belege klären nicht alle Teile der Antwort.",
  };
}
