import { readFile } from "node:fs/promises";
import { collect, collectAll } from "./collect.js";
import { database } from "./db.js";
import { parseFeed, type Candidate } from "./feed.js";
import {
  configuredFeed,
  customFeed,
  fetchFeedXml,
  fixtureFeed,
  publicNewsFeeds,
  type Feed,
} from "./sources.js";

function summarize(feed: Feed, candidates: Candidate[], limit = 3) {
  const valid = candidates.filter((c) => !c.errors.length).length;
  return {
    feed: feed.id,
    publisher: feed.publisher,
    url: feed.url,
    entries: candidates.length,
    valid,
    invalid: candidates.length - valid,
    languages: [...new Set(candidates.map((c) => c.language))],
    firstHeadlines: candidates
      .slice(0, limit)
      .map((c) => ({ headline: c.headline, url: c.originalUrl })),
  };
}

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
      command !== "collect-all" &&
      command !== "verify" &&
      command !== "verify-all") ||
    (needsRunId && !target) ||
    (command === "collect-all" && !target)
  ) {
    console.error(
      "Usage: cli collect <run-id> [feed-url] | collect-fixture <run-id> | collect-all <run-prefix> | verify [feed-url] | verify-all",
    );
    process.exitCode = 1;
    return;
  }
  if (command === "verify-all") {
    const report = [];
    for (const feed of publicNewsFeeds) {
      if (!feed.url) {
        report.push({
          feed: feed.id,
          publisher: feed.publisher,
          url: feed.url,
          error: "Feed has no live URL",
        });
        continue;
      }
      try {
        const xml = await fetchFeedXml(feed.url);
        report.push(summarize(feed, parseFeed(xml, feed.defaultLanguage), 2));
      } catch (error) {
        report.push({
          feed: feed.id,
          publisher: feed.publisher,
          url: feed.url,
          error: error instanceof Error ? error.message : "Verification failed",
        });
      }
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.some((r) => "error" in r)) process.exitCode = 1;
    return;
  }
  const prisma = database();
  try {
    if (command === "collect-all") {
      const results = await collectAll(prisma, target!);
      console.log(JSON.stringify(results, null, 2));
      if (results.some((r) => r.status === "failed")) process.exitCode = 1;
      return;
    }
    if (command === "verify") {
      const inspected = target ? customFeed(target) : configuredFeed;
      if (!inspected.url) throw new Error("No feed URL");
      const xml = await fetchFeedXml(inspected.url);
      console.log(
        JSON.stringify(
          summarize(inspected, parseFeed(xml, inspected.defaultLanguage)),
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
