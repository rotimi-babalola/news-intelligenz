import { createHash } from "node:crypto";
import { publicNewsFeeds } from "./sources.js";

// Private-use permission gate: full-text retention is permitted only for
// hosts on the allowlist. Defaults to the configured public-news feed hosts;
// the operator confirmed private non-commercial use, so no per-publisher
// legal review blocks local extraction, but an unresolved (non-allowlisted)
// host still stores metadata/links only.
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

// SSRF guard on literal destinations only: blocks loopback/link-local/private
// IPv4, bracketed IPv6 loopback/link-local, and local names. Hostnames that
// resolve to private addresses are not inspected here.
// ponytail: no DNS resolution; add resolved-IP check if fetching untrusted hosts.
export function isBlockedDestination(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return true;
  if (url.username || url.password) return true;
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  )
    return true;
  if (host === "::1" || host === "::ffff:127.0.0.1") return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return true;
    const [a, b] = octets as [number, number, number, number];
    if (a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 0 || a >= 224) return true;
    return false;
  }
  if (host.includes(":")) return true;
  return false;
}

export const MAX_REDIRECTS = 3;
export const MAX_HTML_BYTES = 1_000_000;

export type FetchResult =
  | { ok: true; finalUrl: string; html: string }
  | { ok: false; reason: string };

type FetchFn = (url: string) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

// Fetch only the directly linked resource: manual redirect handling with a
// bound, same-guard rechecks per hop, and no credentialed/private targets.
export async function fetchArticleHtml(
  rawUrl: string,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
  allowedHosts: Set<string> = defaultPermittedHosts(),
): Promise<FetchResult> {
  if (!isExtractionPermitted(rawUrl, allowedHosts))
    return { ok: false, reason: "Full-text retention not permitted for host" };
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (isBlockedDestination(current))
      return { ok: false, reason: "Blocked private/local destination" };
    let response: Awaited<ReturnType<FetchFn>>;
    try {
      response = await fetchFn(current);
    } catch {
      return { ok: false, reason: "Fetch failed" };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: "Redirect without location" };
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return { ok: false, reason: "Invalid redirect location" };
      }
      if (!isExtractionPermitted(next, allowedHosts))
        return {
          ok: false,
          reason: "Redirect target host not permitted; kept original link",
        };
      current = next;
      continue;
    }
    if (response.status === 429)
      return { ok: false, reason: "Rate limited; kept original link" };
    if (response.status < 200 || response.status >= 300)
      return { ok: false, reason: `HTTP ${response.status}; kept original link` };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType))
      return { ok: false, reason: `Unsupported format: ${contentType}` };
    const html = await response.text();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES)
      return { ok: false, reason: "Article exceeds size bound" };
    return { ok: true, finalUrl: current, html };
  }
  return { ok: false, reason: "Too many redirects; kept original link" };
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
