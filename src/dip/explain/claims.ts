import { z } from "zod";
import type { Translate } from "./provider";
import { stepDate, stepSource } from "./evidence";
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

export function emptyClaims(): Claims {
  return {
    matter: [],
    stage: [],
    steps: [],
    documents: [],
    unresolved: [],
  };
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
          url: step.sourceUrl,
        },
      },
    ];
  });
}

// The provider omits `matter` unevenly across languages; the earliest titled
// step establishes the subject the proceeding is about.
export function matterClaim(
  steps: TimelineStep[],
  claims: Claim[],
  language: BriefLanguage,
) {
  if (claims.length) return claims;
  const step = steps.find((item) => item.title.trim());
  if (!step) return claims;
  return [
    {
      text:
        language === "en"
          ? `The proceeding concerns ${step.title}.`
          : `Das Verfahren betrifft ${step.title}.`,
      quote: stepSource(step),
      citation: {
        kind: "step" as const,
        stepId: step.apiId,
        url: step.sourceUrl,
      },
    },
  ];
}

// The provider omits `stage` unevenly across languages; the latest step is a
// strictly supported statement of where the matter stands.
export function latestStageClaim(
  steps: TimelineStep[],
  claims: Claim[],
  language: BriefLanguage,
) {
  if (claims.length) return claims;
  const step = steps.at(-1);
  const label = step?.label || step?.title;
  if (!step || !label) return claims;
  return [
    {
      text: [
        stepDate(step, language),
        language === "en"
          ? `Latest documented step: ${label}`
          : `Letzter dokumentierter Schritt: ${label}`,
      ]
        .filter(Boolean)
        .join(" · "),
      quote: stepSource(step),
      citation: {
        kind: "step" as const,
        stepId: step.apiId,
        url: step.sourceUrl,
      },
    },
  ];
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
    const id = `page:${claim.citation.referenceId}:${claim.citation.page}`;
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
