export type SearchSubject =
  | "politics"
  | "employment"
  | "housing"
  | "healthcare"
  | "education"
  | "immigration";

export type SearchQuery = {
  subject: SearchSubject;
  query: string;
};

export const searchQueries: SearchQuery[] = [
  { subject: "politics", query: "Bundesregierung Gesetz Bundestag" },
  { subject: "employment", query: "Beschäftigung Wirtschaft Deutschland" },
  { subject: "housing", query: "Wohnen Miete Wohnungsbau Deutschland" },
  {
    subject: "healthcare",
    query: "Gesundheit Pflege Krankenkasse Deutschland",
  },
  { subject: "education", query: "Bildung Schule Ausbildung Deutschland" },
  {
    subject: "immigration",
    query: "Einwanderung Asyl Zuwanderung Deutschland",
  },
];

export const searchAllowedDomains = [
  "tagesschau.de",
  "deutschlandfunk.de",
] as const;

export function isAllowedSearchHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  return (searchAllowedDomains as readonly string[]).some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`),
  );
}

export function isAllowedSearchUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return isAllowedSearchHost(url.hostname);
}

export type SearchProvider = "exa" | "tavily";

export type SearchResult = {
  url: string;
  title: string;
  rank: number;
};

export type SearchCandidate = {
  headline: string;
  originalUrl: string;
  sourceId: string;
  language: string;
  publishedAt: string | null;
  sourceDate: string;
  query: string;
  provider: SearchProvider;
  rank: number;
  publisher: string;
  errors: string[];
};

// Provenance mapping for one provider response: allowlist enforcement plus
// query/provider/rank capture. Shape matches the feed Candidate fields that
// processJob reads, with search provenance alongside.
export function toSearchCandidates(
  results: SearchResult[],
  query: string,
  provider: SearchProvider,
): SearchCandidate[] {
  return results.map((result) => {
    const errors: string[] = [];
    const headline = result.title;
    const originalUrl = result.url.trim();
    if (!headline.trim()) errors.push("Missing headline");
    if (headline.length > 2000) errors.push("Headline exceeds 2000 characters");
    const publisher = publisherForSearchUrl(originalUrl);
    if (!isAllowedSearchUrl(originalUrl))
      errors.push("URL outside allowed search domains");
    else if (!publisher) errors.push("Invalid HTTP(S) original URL");
    return {
      headline,
      originalUrl,
      sourceId: "",
      language: "de",
      publishedAt: null,
      sourceDate: "",
      query,
      provider,
      rank: result.rank,
      publisher: publisher ?? "",
      errors,
    };
  });
}

// RSS-consistent publisher labels so search discoveries resolve onto the
// same publisher-scoped identity as feed discoveries instead of forking on
// hostname. Unknown hosts fall back to the raw hostname.
export function publisherForSearchHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === "tagesschau.de" || normalized.endsWith(".tagesschau.de"))
    return "tagesschau (ARD)";
  if (
    normalized === "deutschlandfunk.de" ||
    normalized.endsWith(".deutschlandfunk.de")
  )
    return "Deutschlandfunk";
  return normalized;
}

export function publisherForSearchUrl(raw: string): string | null {
  try {
    return publisherForSearchHost(new URL(raw.trim()).hostname);
  } catch {
    return null;
  }
}

// Allowlist applies to both provider results and redirect-resolved
// destinations, so callers pass the final URL through the same check.
export function filterSearchResults(results: SearchResult[]): SearchResult[] {
  return results.filter((result) => isAllowedSearchUrl(result.url));
}

export type RelevanceAssessment = {
  decision: "accepted" | "uncertain";
  reason: string;
};

// ponytail: naive query-term overlap, no stemming or synonyms; upgrade to a
// relevance model when the trial shows this misroutes real results.
// Agent relevance assessment: a valid candidate is accepted when its headline
// shares at least one significant query term, otherwise held as uncertain.
export function assessRelevance(
  headline: string,
  query: string,
): RelevanceAssessment {
  const terms = new Set(
    query
      .toLowerCase()
      .split(/[^a-zäöüß]+/u)
      .filter((term) => term.length > 3),
  );
  const lowered = headline.toLowerCase();
  const matched = [...terms].filter((term) => lowered.includes(term));
  if (matched.length)
    return {
      decision: "accepted",
      reason: `Matched query terms: ${matched.sort().join(", ")}`,
    };
  return { decision: "uncertain", reason: "No query term overlap" };
}
