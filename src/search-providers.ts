import { parseRetryAfterMs, RateLimitedError } from "./jobs";
import { searchAllowedDomains, type SearchResult } from "./search";

export type ProviderFetch = typeof fetch;

export type ProviderOptions = {
  apiKey: string;
  limit?: number;
  startDate?: string;
  endDate?: string;
  fetchFn?: ProviderFetch;
};

export type ProviderResponse = {
  results: SearchResult[];
  usage: { calls: number; costDollars?: number };
};

const MAX_RESULTS = 10;

function requestInit(apiKey: string, header: string, body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", [header]: apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  };
}

async function postJson(
  provider: string,
  url: string,
  init: RequestInit,
  fetchFn: ProviderFetch,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new Error(`${provider} search timed out`);
    throw error;
  }
  if (response.status === 429)
    throw new RateLimitedError(
      `${provider} search rate limited: HTTP 429`,
      parseRetryAfterMs(response.headers.get("retry-after")) ?? 60_000,
    );
  if (!response.ok)
    throw new Error(`${provider} search failed: HTTP ${response.status}`);
  return response;
}

function toResults(items: unknown): SearchResult[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_RESULTS).map((item, index) => {
    const entry = (item ?? {}) as { url?: unknown; title?: unknown };
    return {
      url: typeof entry.url === "string" ? entry.url : "",
      title: typeof entry.title === "string" ? entry.title : "",
      rank: index + 1,
    };
  });
}

function window(defaulted: ProviderOptions) {
  const end = defaulted.endDate ?? new Date().toISOString();
  const start =
    defaulted.startDate ??
    new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  return { start, end };
}

// Live Exa Search call: news category, hard domain filter, no answer or page
// contents (those cost extra). No SDK needed.
export async function fetchExaResults(
  query: string,
  options: ProviderOptions,
): Promise<ProviderResponse> {
  if (!options.apiKey.trim()) throw new Error("Exa API key is missing");
  const limit = Math.min(options.limit ?? MAX_RESULTS, MAX_RESULTS);
  const { start, end } = window(options);
  const response = await postJson(
    "Exa",
    "https://api.exa.ai/search",
    requestInit(options.apiKey, "x-api-key", {
      query,
      type: "auto",
      category: "news",
      includeDomains: [...searchAllowedDomains],
      numResults: limit,
      startPublishedDate: start,
      endPublishedDate: end,
    }),
    options.fetchFn ?? fetch,
  );
  const data = (await response.json()) as {
    results?: unknown;
    costDollars?: unknown;
  };
  return {
    results: toResults(data.results),
    usage: {
      calls: 1,
      ...(typeof data.costDollars === "number"
        ? { costDollars: data.costDollars }
        : {}),
    },
  };
}

// Live Tavily Search call: news topic at basic depth (1 credit), restricted
// domains, no generated answer. No SDK needed.
export async function fetchTavilyResults(
  query: string,
  options: ProviderOptions,
): Promise<ProviderResponse> {
  if (!options.apiKey.trim()) throw new Error("Tavily API key is missing");
  const limit = Math.min(options.limit ?? MAX_RESULTS, MAX_RESULTS);
  const { start, end } = window(options);
  const response = await postJson(
    "Tavily",
    "https://api.tavily.com/search",
    requestInit(`Bearer ${options.apiKey}`, "authorization", {
      query,
      topic: "news",
      search_depth: "basic",
      include_domains: [...searchAllowedDomains],
      include_domains_mode: "restrict",
      max_results: limit,
      start_date: start.slice(0, 10),
      end_date: end.slice(0, 10),
      include_answer: false,
    }),
    options.fetchFn ?? fetch,
  );
  const data = (await response.json()) as { results?: unknown };
  return { results: toResults(data.results), usage: { calls: 1 } };
}

export async function fetchProviderResults(
  provider: "exa" | "tavily",
  query: string,
  options: ProviderOptions,
): Promise<ProviderResponse> {
  return provider === "exa"
    ? fetchExaResults(query, options)
    : fetchTavilyResults(query, options);
}
