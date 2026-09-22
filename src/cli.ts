import { readFile } from "node:fs/promises";
import { collect } from "./collect.js";
import { database } from "./db.js";
import { parseFeed } from "./feed.js";
import { configuredFeed, fetchFeedXml, fixtureFeed } from "./sources.js";

async function main(command: string | undefined, runId: string | undefined) {
  const needsRunId = command === "collect" || command === "collect-fixture";
  if (
    (command !== "collect" &&
      command !== "collect-fixture" &&
      command !== "verify") ||
    (needsRunId && !runId)
  ) {
    console.error(
      "Usage: cli collect <run-id> | collect-fixture <run-id> | verify [feed-url]",
    );
    process.exitCode = 1;
    return;
  }
  const prisma = database();
  try {
    if (command === "verify") {
      const url = process.argv[3] ?? configuredFeed.url;
      if (!url) throw new Error("No feed URL");
      const xml = await fetchFeedXml(url);
      const candidates = parseFeed(xml, configuredFeed.defaultLanguage);
      const valid = candidates.filter((c) => !c.errors.length).length;
      console.log(
        JSON.stringify(
          {
            feed: configuredFeed.id,
            publisher: configuredFeed.publisher,
            url,
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
    const feed = command === "collect-fixture" ? fixtureFeed : configuredFeed;
    const xml =
      command === "collect-fixture"
        ? await readFile("fixtures/bundestag.xml", "utf8")
        : await fetchFeedXml(feed.url!);
    const result = await collect(prisma, runId!, xml, feed);
    console.log(JSON.stringify(result));
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Operation failed");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

await main(process.argv[2], process.argv[3]);
