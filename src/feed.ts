import { XMLParser, XMLValidator } from "fast-xml-parser";

export const feed = {
  id: "bundestag-aktuelle-themen-fixture",
  publisher: "Synthetic Bundestag fixture",
  mode: "fixture",
  liveEnabled: false,
} as const;

export type Candidate = {
  headline: string;
  originalUrl: string;
  sourceId: string;
  publishedAt: string | null;
  sourceDate: string;
  language: string;
  errors: string[];
};

const scalar = (value: unknown): string =>
  typeof value === "string" ? value : "";

export function parseFeed(xml: string): Candidate[] {
  if (Buffer.byteLength(xml) > 1_000_000) throw new Error("Feed exceeds 1 MB");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("XML declarations forbidden");
  if (XMLValidator.validate(xml) !== true) throw new Error("Malformed XML");
  const channel = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
    isArray: (name) => name === "item",
  }).parse(xml)?.rss?.channel;
  if (!channel || typeof channel !== "object")
    throw new Error("Expected RSS channel");
  return (channel.item ?? []).map((item: Record<string, unknown> | null) => {
    const raw = item ?? {};
    const headline = scalar(raw.title);
    const originalUrl = scalar(raw.link).trim();
    const sourceId = scalar(raw.guid).trim();
    const language = scalar(raw["dc:language"] || channel.language).trim();
    const date = scalar(raw.pubDate || raw["dc:date"]).trim();
    const errors: string[] = [];
    if (!headline.trim()) errors.push("Missing headline");
    if (headline.length > 2000) errors.push("Headline exceeds 2000 characters");
    try {
      const url = new URL(originalUrl);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
    } catch {
      errors.push("Invalid HTTP(S) original URL");
    }
    if (language !== "de" && language !== "en")
      errors.push("Expected de or en language");
    const timestamp = date ? Date.parse(date) : NaN;
    if (date && !Number.isFinite(timestamp))
      errors.push("Invalid publication date");
    return {
      headline,
      originalUrl,
      sourceId,
      language,
      sourceDate: date,
      publishedAt: Number.isFinite(timestamp)
        ? new Date(timestamp).toISOString()
        : null,
      errors,
    };
  });
}
