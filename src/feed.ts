import { XMLParser } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";

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

export function parseFeed(
  xml: string,
  defaultLanguage: "de" | "en" = "de",
): Candidate[] {
  if (Buffer.byteLength(xml) > 1_000_000) throw new Error("Feed exceeds 1 MB");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("XML declarations forbidden");
  try {
    SyntaxValidator.validate(xml);
  } catch {
    throw new Error("Malformed XML");
  }
  const parsed = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
    isArray: (name) => name === "item",
  }).parse(xml);
  const rssChannel = parsed?.rss?.channel;
  const rdf = parsed?.["rdf:RDF"];
  // RSS 2.0 nests items under rss/channel; RDF (RSS 1.0, e.g. tagesschau)
  // keeps channel metadata and sibling item elements under rdf:RDF.
  let channel: Record<string, unknown> | null = null;
  let items: Array<Record<string, unknown> | null> = [];
  if (rssChannel && typeof rssChannel === "object") {
    channel = rssChannel as Record<string, unknown>;
    if (Array.isArray(channel.item)) {
      items = channel.item as Array<Record<string, unknown> | null>;
    }
  } else if (rdf && typeof rdf === "object") {
    const rdfRoot = rdf as Record<string, unknown>;
    const rdfChannel = rdfRoot.channel;
    if (rdfChannel && typeof rdfChannel === "object") {
      channel = rdfChannel as Record<string, unknown>;
    } else {
      channel = {};
    }
    if (Array.isArray(rdfRoot.item)) {
      items = rdfRoot.item as Array<Record<string, unknown> | null>;
    } else if (Array.isArray(channel.item)) {
      items = channel.item as Array<Record<string, unknown> | null>;
    }
  }
  if (!channel) throw new Error("Expected RSS channel");
  return items.map((item) => {
    const raw = item ?? {};
    const headline = scalar(raw.title);
    const originalUrl = scalar(raw.link).trim();
    const sourceId = scalar(raw.guid).trim();
    const language =
      scalar(raw["dc:language"] || channel.language || channel["dc:language"])
        .split("-")[0]
        ?.trim()
        .toLowerCase() || defaultLanguage;
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
