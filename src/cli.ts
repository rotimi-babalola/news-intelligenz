import { database } from "./db";
import {
  collect,
  collectAll,
  collectFixtureRun,
  verifyAllFeeds,
  verifyFeed,
} from "./import/service";
import { configuredFeed, customFeed, fetchFeedXml, type Feed } from "./sources";

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
    const report = await verifyAllFeeds();
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
      console.log(JSON.stringify(await verifyFeed(target), null, 2));
      return;
    }
    if (command === "collect-fixture") {
      const result = await collectFixtureRun(prisma, target!);
      console.log(JSON.stringify(result));
      if (result.status === "failed") process.exitCode = 1;
      return;
    }
    let feed: Feed;
    if (feedUrl) feed = customFeed(feedUrl);
    else feed = configuredFeed;
    const xml = await fetchFeedXml(feed.url!);
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
