export function normalizePublisher(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "igshid",
  "si",
]);

function isTrackingParam(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith("utm_") || TRACKING_PARAMS.has(normalized);
}

const compareStrings = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export function canonicalArticleUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return trimmed;
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  )
    url.port = "";
  url.hash = "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/"))
    url.pathname = url.pathname.slice(0, -1);
  const kept: Array<[string, string]> = [];
  url.searchParams.forEach((value, name) => {
    if (!isTrackingParam(name)) kept.push([name, value]);
  });
  kept.sort(
    ([aName, aValue], [bName, bValue]) =>
      compareStrings(aName, bName) || compareStrings(aValue, bValue),
  );
  url.search = "";
  for (const [name, value] of kept) url.searchParams.append(name, value);
  return url.toString();
}

export function normalizeIdentifierValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" || url.protocol === "http:")
      return canonicalArticleUrl(trimmed);
  } catch {
    // Not a URL; fall through to the trimmed value.
  }
  return trimmed;
}
