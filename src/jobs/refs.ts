export type SourceKind = "news_feed" | "search_query" | "dip_endpoint";
export type SourceRef = {
  kind: SourceKind;
  key: string;
  scope?: unknown;
};

export function feedSource(feedId: string): SourceRef {
  return { kind: "news_feed", key: feedId };
}

export function searchSource(
  query: string,
  domains?: string[],
  provider?: string,
): SourceRef {
  const scope: Record<string, unknown> = {};
  if (domains) scope.domains = domains;
  if (provider) scope.provider = provider;
  return {
    kind: "search_query",
    key: query,
    scope: Object.keys(scope).length ? scope : undefined,
  };
}

export function dipSource(endpoint: string, electoralTerm?: string): SourceRef {
  return {
    kind: "dip_endpoint",
    key: endpoint,
    scope: electoralTerm ? { electoralTerm } : undefined,
  };
}
