import { z } from "zod";
import { MIN_CLAIM_QUOTE_LENGTH } from "../constants";
import { verifyClaims, type Verify } from "./provider";
import {
  sections,
  type BriefLanguage,
  type Claims,
  type Evidence,
} from "./types";

const claimSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  evidenceId: z.string(),
  quote: z.string().trim().min(MIN_CLAIM_QUOTE_LENGTH),
});
const answerSchema = z.object({
  matter: z.array(z.unknown()).catch([]),
  stage: z.array(z.unknown()).catch([]),
  steps: z.array(z.unknown()).catch([]),
  documents: z.array(z.unknown()).catch([]),
  unresolved: z.array(z.unknown()).catch([]),
});

function sourceQuote(text: string, quote: string) {
  const pattern = quote
    .trim()
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return text.match(new RegExp(pattern, "u"))?.[0] ?? null;
}

function validateCitations(raw: unknown, evidence: Evidence[]): Claims {
  const parsed = answerSchema.parse(raw);
  const sources = new Map(evidence.map((item) => [item.id, item]));
  const result = {} as Claims;
  for (const section of sections) {
    result[section] = parsed[section].flatMap((item) => {
      const parsedClaim = claimSchema.safeParse(item);
      if (!parsedClaim.success) return [];
      const claim = parsedClaim.data;
      const source = sources.get(claim.evidenceId);
      const quote = source && sourceQuote(source.text, claim.quote);
      if (!source || !quote) return [];
      if (section === "documents" && source.citation.kind !== "page") return [];
      if (
        (section === "stage" || section === "steps") &&
        source.citation.kind !== "step"
      )
        return [];
      return [{ text: claim.text, quote, citation: source.citation }];
    });
  }
  return result;
}

export async function validateAnswer(
  raw: unknown,
  evidence: Evidence[],
  language: BriefLanguage,
  verify: Verify = verifyClaims,
) {
  const result = validateCitations(raw, evidence);
  const claims = sections
    .flatMap((section) =>
      result[section].map((claim) => ({ section, ...claim })),
    )
    .map((claim, id) => ({ id, ...claim }));
  if (!claims.length) return result;
  // shortcut: model verification is probabilistic; require human review before auto-publishing.
  const verdict = z
    .object({
      supportedClaimIds: z.array(
        z
          .number()
          .int()
          .min(0)
          .max(claims.length - 1),
      ),
    })
    .parse(await verify({ language, evidence, claims }));
  const supported = new Set(verdict.supportedClaimIds);
  for (const section of sections) {
    result[section] = claims
      .filter((claim) => claim.section === section && supported.has(claim.id))
      .map(({ id, section, ...claim }) => claim);
  }
  return result;
}
