import { createHash } from "node:crypto";
import { publicNewsFeeds } from "./sources";
import {
  FETCH_USER_AGENT,
  fetchWithRedirects,
  type ResolveHost,
} from "./url-safety";

// Private-use permission gate: full-text retention is permitted only for
// hosts on the allowlist. Defaults to the configured public-news feed hosts;
// the operator confirmed private non-commercial use and approved local
// retention. Non-allowlisted hosts still store metadata/links only.
export function defaultPermittedHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const feed of publicNewsFeeds) {
    if (!feed.url) continue;
    try {
      hosts.add(new URL(feed.url).hostname.toLowerCase());
    } catch {
      // Ignore malformed configured URLs.
    }
  }
  return hosts;
}

export function isExtractionPermitted(
  rawUrl: string,
  allowedHosts: Set<string> = defaultPermittedHosts(),
): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.has(host);
}

export const MAX_HTML_BYTES = 1_000_000;
const ARTICLE_FETCH_TIMEOUT_MS = 15_000;

export type FetchResult =
  { ok: true; finalUrl: string; html: string } | { ok: false; reason: string };

type FetchFn = (
  url: string,
  init?: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

function defaultFetch(
  url: string,
  init?: { signal: AbortSignal; headers: Record<string, string> },
) {
  return fetch(url, {
    signal: init?.signal,
    headers: init?.headers ?? {},
    redirect: "manual",
  });
}

// Fetch only the directly linked resource: manual redirect handling with a
// bound, same-guard rechecks per hop, and no credentialed/private targets.
// The feed-host allowlist bounds this fetcher; pass resolveHost to add the
// resolved-IP check for broader host sets.
export async function fetchArticleHtml(
  rawUrl: string,
  fetchFn: FetchFn = defaultFetch,
  allowedHosts: Set<string> = defaultPermittedHosts(),
  resolveHost?: ResolveHost,
): Promise<FetchResult> {
  if (!isExtractionPermitted(rawUrl, allowedHosts))
    return { ok: false, reason: "Full-text retention not permitted for host" };
  const result = await fetchWithRedirects(rawUrl, {
    fetchFn,
    headers: {
      "user-agent": FETCH_USER_AGENT,
      accept: "text/html, application/xhtml+xml",
    },
    timeoutMs: ARTICLE_FETCH_TIMEOUT_MS,
    contentType: /text\/html|application\/xhtml/i,
    maxBytes: MAX_HTML_BYTES,
    sizeReason: "Article exceeds size bound",
    permittedHost: (url) =>
      isExtractionPermitted(url.toString(), allowedHosts)
        ? null
        : "Redirect target host not permitted; kept original link",
    resolveHost,
    remoteFailure: (reason) =>
      `${reason === "HTTP 429" ? "Rate limited" : reason}; kept original link`,
    read: async (response) => {
      const html = await response.text();
      return { bytes: Buffer.byteLength(html), value: html };
    },
  });
  if (!result.ok) return result;
  return { ok: true, finalUrl: result.finalUrl, html: result.value };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// Generic HTML extraction: no publisher-specific selectors. Prefers
// <article>/<main> when present, otherwise falls back to <body>. Feed
// excerpts (RSS description/content:encoded) are never an input here, so
// stored text is always fetched article text, never an excerpt.
export function extractArticleText(html: string): string | null {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<template[\s\S]*?<\/template\s*>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav\s*>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer\s*>/gi, " ")
    .replace(/<header[\s\S]*?<\/header\s*>/gi, " ");
  const region =
    stripped.match(/<article[\s\S]*?<\/article\s*>/i)?.[0] ??
    stripped.match(/<main[\s\S]*?<\/main\s*>/i)?.[0] ??
    stripped.match(/<body[\s\S]*?<\/body\s*>/i)?.[0] ??
    stripped;
  const text = decodeEntities(
    region
      .replace(/<[^>]*>/g, " ")
      .replace(/[ \t\f\v \u1680\u2000-\u200a\u202f\u205f\u3000]+/g, " ")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n"),
  ).trim();
  return text.length >= 50 ? text : null;
}

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function isChangedText(
  latestHash: string | null,
  text: string,
): boolean {
  return latestHash !== textHash(text);
}
