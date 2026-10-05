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
  { subject: "healthcare", query: "Gesundheit Pflege Krankenkasse Deutschland" },
  { subject: "education", query: "Bildung Schule Ausbildung Deutschland" },
  { subject: "immigration", query: "Einwanderung Asyl Zuwanderung Deutschland" },
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

export type SearchResult = {
  url: string;
  title: string;
  rank: number;
};

// Allowlist applies to both provider results and redirect-resolved
// destinations, so callers pass the final URL through the same check.
export function filterSearchResults(results: SearchResult[]): SearchResult[] {
  return results.filter((result) => isAllowedSearchUrl(result.url));
}
