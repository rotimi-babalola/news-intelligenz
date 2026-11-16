import { isIP } from "node:net";

// One operator-identifying user agent for every outbound source fetch.
export const FETCH_USER_AGENT =
  "NewsIntelligenz/0.1 (local operator verification)";
const MAX_REDIRECTS = 3;

type Headers = { get(name: string): string | null };
export type FetchResponse = { status: number; headers: Headers };
export type FetchInit = {
  signal: AbortSignal;
  headers: Record<string, string>;
};
export type FetchFn<R extends FetchResponse> = (
  url: string,
  init: FetchInit,
) => Promise<R>;

export type ResolveHost = (hostname: string) => Promise<string[]>;

export type GuardedFetchResult<T> =
  { ok: true; finalUrl: string; value: T } | { ok: false; reason: string };

export type GuardedFetchOptions<R extends FetchResponse, T> = {
  fetchFn: FetchFn<R>;
  headers: Record<string, string>;
  timeoutMs: number;
  /** Accepted content type; empty or missing headers pass. */
  contentType: RegExp;
  maxBytes: number;
  sizeReason: string;
  /** Rejects a hop outside the caller's allowlist; null allows it. */
  permittedHost?: (url: URL) => string | null;
  /** Resolves every hop before its request; the caller opts into DNS checks. */
  resolveHost?: ResolveHost;
  /** Rewrites remote failure reasons, e.g. to note the original link was kept. */
  remoteFailure?: (reason: string) => string;
  /** Rejects an oversized declared length before reading; off by default. */
  checkContentLength?: boolean;
  emptyReason?: string;
  read: (response: R) => Promise<{ bytes: number; value: T }>;
};

// SSRF guard on literal destinations only: blocks loopback/link-local/private
// IPv4, bracketed IPv6 loopback/link-local, and local names. Hostnames that
// resolve to private addresses are inspected by isBlockedResolved instead.
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

// A hostname can pass the literal URL check and still resolve to a private
// address, so every hop is resolved before the request is made.
async function isBlockedResolved(
  rawUrl: string,
  resolveHost: ResolveHost,
): Promise<boolean> {
  const url = new URL(rawUrl);
  if (isIP(url.hostname)) return false;
  let addresses: string[];
  try {
    addresses = await resolveHost(url.hostname);
  } catch {
    return true;
  }
  if (addresses.length === 0) return true;
  return addresses.some((address) =>
    isBlockedDestination(
      `http://${address.includes(":") ? `[${address}]` : address}`,
    ),
  );
}

// Fetch only the linked resource: manual redirects with a hop bound, the
// destination policy rechecked per hop, one size bound and one content-type
// check.
export async function fetchWithRedirects<R extends FetchResponse, T>(
  rawUrl: string,
  options: GuardedFetchOptions<R, T>,
): Promise<GuardedFetchResult<T>> {
  const remoteFailure = options.remoteFailure ?? ((reason: string) => reason);
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (isBlockedDestination(current))
      return { ok: false, reason: "Blocked private/local destination" };
    if (
      options.resolveHost &&
      (await isBlockedResolved(current, options.resolveHost))
    )
      return { ok: false, reason: "Blocked private/local destination" };
    if (options.permittedHost) {
      const reason = options.permittedHost(new URL(current));
      if (reason) return { ok: false, reason };
    }
    let response: R;
    try {
      response = await options.fetchFn(current, {
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: options.headers,
      });
    } catch {
      return { ok: false, reason: "Fetch failed" };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: "Redirect without location" };
      try {
        current = new URL(location, current).toString();
      } catch {
        return { ok: false, reason: "Invalid redirect location" };
      }
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      return {
        ok: false,
        reason: remoteFailure(`HTTP ${response.status}`),
      };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !options.contentType.test(contentType))
      return { ok: false, reason: `Unsupported format: ${contentType}` };
    const declaredSize = response.headers.get("content-length");
    if (
      options.checkContentLength &&
      declaredSize !== null &&
      Number(declaredSize) > options.maxBytes
    )
      return { ok: false, reason: options.sizeReason };
    const body = await options.read(response);
    if (body.bytes === 0 && options.emptyReason)
      return { ok: false, reason: options.emptyReason };
    if (body.bytes > options.maxBytes)
      return { ok: false, reason: options.sizeReason };
    return { ok: true, finalUrl: current, value: body.value };
  }
  return {
    ok: false,
    reason: remoteFailure("Too many redirects"),
  };
}
