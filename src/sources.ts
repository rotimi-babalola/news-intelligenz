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

export const fixtureFeed: Feed = {
  id: "bundestag-aktuelle-themen-fixture",
  publisher: "Synthetic Bundestag fixture",
  url: null,
  defaultLanguage: "de",
};

export async function fetchFeedXml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "NewsIntelligenz/0.1 (local operator verification)",
        accept: "application/rss+xml, application/xml, text/xml",
      },
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`Feed fetch failed: HTTP ${response.status}`);
    const xml = await response.text();
    if (Buffer.byteLength(xml) > 1_000_000)
      throw new Error("Feed exceeds 1 MB");
    return xml;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Feed fetch timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
