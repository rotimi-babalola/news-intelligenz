import { z } from "zod";
import type { Translate, TranslateTerms } from "./provider";
import { stepDate, stepSource, pageEvidenceId } from "./evidence";
import { sourceStepUrl } from "../proceedings/source";
import type {
  BriefLanguage,
  Claim,
  Claims,
  Evidence,
  TimelineStep,
} from "./types";

const translationSchema = z.object({
  claims: z.array(z.object({ id: z.string(), text: z.string().trim().min(1) })),
});

const termsSchema = z.object({
  terms: z.array(z.object({ id: z.string(), text: z.string().trim().min(1) })),
});

const selectionSchema = z
  .object({
    claimIds: z.array(z.string().trim().min(1)).catch([]),
  })
  .catch({ claimIds: [] });

export function emptyClaims(): Claims {
  return {
    answer: [],
    matter: [],
    stage: [],
    steps: [],
    documents: [],
    unresolved: [],
  };
}

// The selector only returns ids; the claim text, quote and citation are copied
// from the verified claim, so selection cannot introduce an uncited statement.
export function selectedAnswerClaims(
  candidates: { id: string; claim: Claim }[],
  raw: unknown,
) {
  const byId = new Map(candidates.map(({ id, claim }) => [id, claim]));
  const ids = new Set(selectionSchema.parse(raw).claimIds);
  return [...ids].flatMap((id) => byId.get(id) ?? []).slice(0, 2);
}

export function orderedStepClaims(
  steps: TimelineStep[],
  claims: Claim[],
  language: BriefLanguage,
) {
  return steps.flatMap((step) => {
    const cited = claims.filter(
      (claim) => claim.citation.stepId === step.apiId,
    );
    if (cited.length) return cited;
    const label = step.label || step.title;
    if (!label) return [];
    const date = stepDate(step, language);
    return [
      {
        text: [
          date,
          language === "en"
            ? "A proceeding step is documented."
            : "Ein Verfahrensschritt ist dokumentiert.",
        ]
          .filter(Boolean)
          .join(" · "),
        quote: stepSource(step),
        citation: {
          kind: "step" as const,
          stepId: step.apiId,
          url: sourceStepUrl(step.apiId),
        },
      },
    ];
  });
}

// The provider omits `matter` and `stage` unevenly across languages. One call
// translates both fallback terms; the German source stays the quote, never the
// English claim text.
export async function stepFallbackClaims(
  steps: TimelineStep[],
  matterClaims: Claim[],
  stageClaims: Claim[],
  language: BriefLanguage,
  translateTerms: TranslateTerms,
) {
  const matterStep = matterClaims.length
    ? undefined
    : steps.find((item) => item.title.trim());
  const stageStep = stageClaims.length ? undefined : steps.at(-1);
  const stageLabel = stageStep?.label || stageStep?.title;
  const terms = [
    ...new Set(
      [matterStep?.title, stageLabel].filter((text): text is string =>
        Boolean(text?.trim()),
      ),
    ),
  ];
  const translated = new Map<string, string>();
  if (language === "en" && terms.length) {
    const parsed = termsSchema.parse(
      await translateTerms({
        language,
        terms: terms.map((text, index) => ({ id: String(index), text })),
      }),
    );
    for (const item of parsed.terms) {
      const text = terms[Number(item.id)];
      if (text) translated.set(text, item.text.replace(/[.;]+$/u, "").trim());
    }
  }
  const term = (text: string | undefined) => {
    if (!text?.trim()) return null;
    return language === "en" ? (translated.get(text) ?? null) : text;
  };
  const matterTitle = matterStep ? term(matterStep.title) : null;
  const stageTerm = stageStep && stageLabel ? term(stageLabel) : null;
  return {
    matter:
      matterStep && matterTitle
        ? [
            {
              text:
                language === "en"
                  ? `The proceeding concerns ${matterTitle}.`
                  : `Das Verfahren betrifft ${matterTitle}.`,
              quote: stepSource(matterStep),
              citation: {
                kind: "step" as const,
                stepId: matterStep.apiId,
                url: sourceStepUrl(matterStep.apiId),
              },
            },
          ]
        : matterClaims,
    stage:
      stageStep && stageTerm
        ? [
            {
              text: [
                stepDate(stageStep, language),
                language === "en"
                  ? `Latest documented step: ${stageTerm}`
                  : `Letzter dokumentierter Schritt: ${stageTerm}`,
              ]
                .filter(Boolean)
                .join(" · "),
              quote: stepSource(stageStep),
              citation: {
                kind: "step" as const,
                stepId: stageStep.apiId,
                url: sourceStepUrl(stageStep.apiId),
              },
            },
          ]
        : stageClaims,
  };
}

// A claim that repeats the German source is not an English translation.
function copiedText(text: string, source: string) {
  const normalize = (value: string) =>
    value.replace(/\s+/gu, " ").trim().toLowerCase();
  return normalize(source).includes(normalize(text));
}

// Both briefs cite the pages the search retrieved, whatever each language's
// generator and verifier happened to keep: a page without a verified claim gets
// a translated one. A page that states several relevant facts keeps them all,
// each with its own quote and the same page citation.
export async function alignDocumentClaims(
  evidence: Evidence[],
  claims: Claim[],
  language: BriefLanguage,
  translate: Translate,
) {
  const pages = new Map<string, Evidence>();
  for (const item of evidence)
    if (item.citation.kind === "page" && !pages.has(item.id))
      pages.set(item.id, item);
  const kept = new Map<string, Claim[]>();
  for (const claim of claims) {
    if (claim.citation.kind !== "page") continue;
    const { referenceId, page: pageNo } = claim.citation;
    if (!referenceId || pageNo === undefined) continue;
    const id = pageEvidenceId(referenceId, pageNo);
    const page = pages.get(id);
    if (!page) continue;
    if (language === "en" && copiedText(claim.text, page.text)) continue;
    kept.set(id, [...(kept.get(id) ?? []), claim]);
  }
  const missing = [...pages.values()].filter((page) => !kept.has(page.id));
  if (missing.length) {
    const translated = translationSchema.parse(
      await translate({
        language,
        pages: missing.map(({ id, text }) => ({ id, text })),
      }),
    );
    for (const item of translated.claims) {
      const page = pages.get(item.id);
      if (!page || kept.has(item.id)) continue;
      kept.set(item.id, [
        {
          text: item.text,
          quote: page.text,
          citation: page.citation,
        },
      ]);
    }
  }
  return [...pages.values()].flatMap((page) => kept.get(page.id) ?? []);
}
