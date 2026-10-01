import { createHash } from "node:crypto";
import { parseRetryAfterMs, RateLimitedError } from "./jobs";

export type Feed = {
  id: string;
  publisher: string;
  url: string | null;
  defaultLanguage: "de" | "en";
};

export const configuredFeed: Feed = {
  id: "deutschlandfunk-nachrichten",
  publisher: "Deutschlandfunk",
  url: "https://www.deutschlandfunk.de/nachrichten-100.rss",
  defaultLanguage: "de",
};

export const publicNewsFeeds: Feed[] = [
  {
    id: "tagesschau-alle-meldungen",
    publisher: "tagesschau (ARD)",
    url: "https://www.tagesschau.de/infoservices/alle-meldungen-100~rdf.xml",
    defaultLanguage: "de",
  },
  configuredFeed,
  {
    id: "deutschlandfunk-politik",
    publisher: "Deutschlandfunk",
    url: "https://www.deutschlandfunk.de/politikportal-100.rss",
    defaultLanguage: "de",
  },
  {
    id: "deutschlandfunk-wirtschaft",
    publisher: "Deutschlandfunk",
    url: "https://www.deutschlandfunk.de/wirtschaft-106.rss",
    defaultLanguage: "de",
  },
  {
    id: "deutschlandfunk-wissen",
    publisher: "Deutschlandfunk",
    url: "https://www.deutschlandfunk.de/wissen-106.rss",
    defaultLanguage: "de",
  },
  {
    id: "deutschlandfunk-kultur",
    publisher: "Deutschlandfunk",
    url: "https://www.deutschlandfunk.de/kulturportal-100.rss",
    defaultLanguage: "de",
  },
  {
    id: "deutschlandfunk-europa",
    publisher: "Deutschlandfunk",
    url: "https://www.deutschlandfunk.de/europa-112.rss",
    defaultLanguage: "de",
  },
  {
    id: "deutschlandfunk-gesellschaft",
    publisher: "Deutschlandfunk",
    url: "https://www.deutschlandfunk.de/gesellschaft-106.rss",
    defaultLanguage: "de",
  },
  {
    id: "deutschlandfunk-sport",
    publisher: "Deutschlandfunk",
    url: "https://www.deutschlandfunk.de/sportportal-100.rss",
    defaultLanguage: "de",
  },
];

export const fixtureFeed: Feed = {
  id: "bundestag-aktuelle-themen-fixture",
  publisher: "Synthetic Bundestag fixture",
  url: null,
  defaultLanguage: "de",
};

// Operator-driven import of any RSS 2.0 URL for local QA. Identity scope is
// per host: distinct URLs on one host share a publisher, while different URLs
// always get distinct feed IDs, so provenance stays visible in runs.
export function customFeed(url: string): Feed {
  let host = "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:")
      host = parsed.hostname;
  } catch {
    host = "";
  }
  if (!host) throw new Error("Custom feed URL must be an absolute HTTP(S) URL");
  const suffix = createHash("sha256").update(url).digest("hex").slice(0, 8);
  return {
    id: `custom-${host}-${suffix}`,
    publisher: host,
    url,
    defaultLanguage: "de",
  };
}

export async function fetchFeedXml(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "NewsIntelligenz/0.1 (local operator verification)",
        accept: "application/rss+xml, application/xml, text/xml",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      // Back off this provider; collectAll keeps other feeds moving and the
      // job worker reuses the delay for downstream retries.
      const retryAfterMs =
        parseRetryAfterMs(response.headers.get("retry-after")) ?? 60_000;
      throw new RateLimitedError(
        `Feed rate limited: HTTP 429 (retry after ${Math.ceil(retryAfterMs / 1000)}s)`,
        retryAfterMs,
      );
    }
    if (!response.ok)
      throw new Error(`Feed fetch failed: HTTP ${response.status}`);
    const xml = await response.text();
    if (Buffer.byteLength(xml) > 1_000_000)
      throw new Error("Feed exceeds 1 MB");
    return xml;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new Error("Feed fetch timed out");
    throw error;
  }
}
