import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimitedError } from "../src/jobs.js";
import {
  fetchExaResults,
  fetchTavilyResults,
} from "../src/search-providers.js";

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { calls, fetchFn };
}

const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), { status, headers });

test("exa sends a news-category domain-restricted query without paid extras", async () => {
  const { calls, fetchFn } = stubFetch(() =>
    json({
      results: [{ url: "https://www.tagesschau.de/a.html", title: "A" }],
      costDollars: 0.007,
    }),
  );
  const response = await fetchExaResults("Schule Ausbildung", {
    apiKey: "exa-key",
    limit: 5,
    startDate: "2026-10-03T00:00:00.000Z",
    endDate: "2026-10-05T00:00:00.000Z",
    fetchFn,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.exa.ai/search");
  const init = calls[0]?.init;
  assert.equal(
    (init?.headers as Record<string, string>)["x-api-key"],
    "exa-key",
  );
  const body = JSON.parse(init?.body as string);
  assert.equal(body.type, "auto");
  assert.equal(body.category, "news");
  assert.deepEqual(body.includeDomains, [
    "tagesschau.de",
    "deutschlandfunk.de",
  ]);
  assert.equal(body.numResults, 5);
  assert.equal(body.startPublishedDate, "2026-10-03T00:00:00.000Z");
  assert.ok(!("contents" in body) && !("text" in body));
  assert.deepEqual(response.results, [
    { url: "https://www.tagesschau.de/a.html", title: "A", rank: 1 },
  ]);
  assert.deepEqual(response.usage, { calls: 1, costDollars: 0.007 });
});

test("tavily uses basic news search with restricted domains and no answer", async () => {
  const { calls, fetchFn } = stubFetch(() =>
    json({
      results: [{ url: "https://www.deutschlandfunk.de/b.html", title: "B" }],
    }),
  );
  const response = await fetchTavilyResults("Schule Ausbildung", {
    apiKey: "tavily-key",
    fetchFn,
  });
  assert.equal(calls[0]?.url, "https://api.tavily.com/search");
  const init = calls[0]?.init;
  assert.equal(
    (init?.headers as Record<string, string>)["authorization"],
    "Bearer tavily-key",
  );
  const body = JSON.parse(init?.body as string);
  assert.equal(body.topic, "news");
  assert.equal(body.search_depth, "basic");
  assert.deepEqual(body.include_domains, [
    "tagesschau.de",
    "deutschlandfunk.de",
  ]);
  assert.equal(body.include_domains_mode, "restrict");
  assert.equal(body.max_results, 10);
  assert.equal(body.include_answer, false);
  assert.match(body.start_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(response.results, [
    { url: "https://www.deutschlandfunk.de/b.html", title: "B", rank: 1 },
  ]);
  assert.deepEqual(response.usage, { calls: 1 });
});

test("provider clients cap results, reject missing keys and failed calls", async () => {
  await assert.rejects(
    fetchExaResults("q", { apiKey: "  " }),
    /API key is missing/,
  );
  const { fetchFn: failing } = stubFetch(() => json({}, 500));
  await assert.rejects(
    fetchExaResults("q", { apiKey: "k", fetchFn: failing }),
    /HTTP 500/,
  );
  const { fetchFn: limited } = stubFetch(() =>
    json({ results: [{ url: "u", title: "t" }] }),
  );
  await fetchTavilyResults("q", { apiKey: "k", limit: 99, fetchFn: limited });
  const { fetchFn: ratelimited } = stubFetch(() =>
    json({}, 429, { "retry-after": "120" }),
  );
  try {
    await fetchExaResults("q", { apiKey: "k", fetchFn: ratelimited });
    assert.fail("expected a rate-limited error");
  } catch (error) {
    assert.ok(error instanceof RateLimitedError);
    assert.equal(error.retryAfterMs, 120_000);
  }
});
