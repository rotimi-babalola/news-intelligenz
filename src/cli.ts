import { readFile } from "node:fs/promises";
import { collect } from "./collect.js";
import { database } from "./db.js";
import { parseFeed } from "./feed.js";
import {
  configuredFeed,
  customFeed,
  fetchFeedXml,
  fixtureFeed,
  type Feed,
} from "./sources.js";

async function main(
  command: string | undefined,
  // Run ID for collect/collect-fixture; feed URL for verify.
  target: string | undefined,
  // Optional feed URL for collect.
  feedUrl: string | undefined,
) {
  const needsRunId = command === "collect" || command === "collect-fixture";
  if (
    (command !== "collect" &&
      command !== "collect-fixture" &&
      command !== "verify") ||
    (needsRunId && !target)
  ) {
    console.error(
      "Usage: cli collect <run-id> [feed-url] | collect-fixture <run-id> | verify [feed-url]",
    );
    process.exitCode = 1;
    return;
  }
  const prisma = database();
  try {
    if (command === "verify") {
      const inspected = target ? customFeed(target) : configuredFeed;
      if (!inspected.url) throw new Error("No feed URL");
      const xml = await fetchFeedXml(inspected.url);
      const candidates = parseFeed(xml, inspected.defaultLanguage);
      const valid = candidates.filter((c) => !c.errors.length).length;
      console.log(
        JSON.stringify(
          {
            feed: inspected.id,
            publisher: inspected.publisher,
            url: inspected.url,
            entries: candidates.length,
            valid,
            invalid: candidates.length - valid,
            languages: [...new Set(candidates.map((c) => c.language))],
            firstHeadlines: candidates
              .slice(0, 3)
              .map((c) => ({ headline: c.headline, url: c.originalUrl })),
          },
          null,
          2,
        ),
      );
      return;
    }
    let feed: Feed;
    if (command === "collect-fixture") feed = fixtureFeed;
    else if (feedUrl) feed = customFeed(feedUrl);
    else feed = configuredFeed;
    const xml =
      command === "collect-fixture"
        ? await readFile("fixtures/bundestag.xml", "utf8")
        : await fetchFeedXml(feed.url!);
    const result = await collect(prisma, target!, xml, feed);
    console.log(JSON.stringify(result));
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Operation failed");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

await main(process.argv[2], process.argv[3], process.argv[4]);
