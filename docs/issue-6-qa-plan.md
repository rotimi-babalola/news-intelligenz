# Issue #6 QA plan — fixed search collection, relevance review, provider budgets

Goal: prove the end-to-end loop for this ticket — collect fixed search
results with query/provider/rank provenance, confirm the agent relevance
gate and operator review in PostgreSQL, and verify an exhausted provider
pauses while RSS continues. See the [table reference](database-tables.md)
for what each record means and the [provider
research](issue-6-search-provider-research.md) for the free-allowance
background and terms cautions.

No HTTP trigger for search collection exists yet (scheduling is issue #8),
so search cases drive the service layer with short `node` scripts against
`dist/` (built by `pnpm build:test`). The operator review step does have an
HTTP route and is exercised with `curl`. Live-provider calls are opt-in
(QA-7 only) and cost at most 2 Search calls; everything else uses fixtures
and touches no provider.

## Prerequisites

```sh
pnpm install --frozen-lockfile
cp .env.example .env   # once; DATABASE_URL points at local Compose PostgreSQL
docker compose up -d --wait
pnpm build:test && pnpm build
pnpm start   # in one terminal; the app serves http://127.0.0.1:3000
```

Use fresh run IDs per case (suggestions below). Do not set `EXA_API_KEY` /
`TAVILY_API_KEY` except for QA-7.

## Cases

### QA-1 — Automated suite still passes

```sh
pnpm check && pnpm test && pnpm format
node --env-file-if-exists=.env --test \
  dist/test/search-persistence.integration.js \
  dist/test/search-relevance.integration.js \
  dist/test/search-budget.integration.js
```

Expected: type check clean, 49 unit tests pass, all 3 search
integrations pass in their self-created isolated schemas, formatting
clean.

### QA-2 — Fixture search intake records provenance and agent decisions

```sh
node --env-file=.env --input-type=module -e "
import('./dist/src/db.js').then(async ({ database }) => {
  const { collectSearch } = await import('./dist/src/import/service.js');
  const prisma = database();
  const run = await collectSearch(prisma, 'qa-search-001',
    'Bildung Schule Ausbildung Deutschland', 'exa', [
      { url: 'https://www.deutschlandfunk.de/schule-qa-100.html',
        title: 'Schule braucht mehr Personal', rank: 1 },
      { url: 'https://www.tagesschau.de/tankrabatt-qa-100.html',
        title: 'Kabinett beschliesst Tankrabatt', rank: 2 },
    ], async () => ({ ok: false, reason: 'Unsupported format: QA stub' }));
  console.log(JSON.stringify(run));
  await prisma.\$disconnect();
})"
```

Expected: `status: "completed"`, `sourceKind: "search_query"`,
`validCount: 1` (query-matching headline accepted),
`invalidCount: 1` (non-matching headline held as uncertain). In Studio
(`pnpm studio`): the `runs` row carries `sourceScope`
`{domains: ["tagesschau.de", "deutschlandfunk.de"], provider: "exa",
query: ...}`; `candidates` rows carry `rank`/`provider`/`query` in
`metadata`; `relevance_reviews` holds `accepted` (reason lists `schule`,
`decided_by: "agent"`) and `uncertain` rows; `publications` and
`discoveries` each hold exactly one row (the accepted headline only).

### QA-3 — Operator accepts and rejects via the review route

```sh
curl -X POST http://127.0.0.1:3000/api/review-search-candidate \
  -H 'Content-Type: application/json' \
  -d '{"runId":"qa-search-001","itemIndex":1,"decision":"accepted","reason":"Relevant to education policy"}'
curl -X POST http://127.0.0.1:3000/api/review-search-candidate \
  -H 'Content-Type: application/json' \
  -d '{"runId":"qa-search-001","itemIndex":1,"decision":"rejected","reason":"Wrong check"}'
```

Expected: the accept returns the decision row (`accepted`,
`decided_by: "operator"`) and a second publication/discovery appears for
the run; the later reject only rewrites the decision row (already
resolved publications are not retracted). Re-accepting an already
resolved candidate creates no duplicate publication or discovery.

### QA-4 — Review guards stay shut

```sh
curl -X POST http://127.0.0.1:3000/api/review-search-candidate \
  -H 'Content-Type: application/json' \
  -d '{"runId":"qa-search-001","itemIndex":0,"decision":"maybe","reason":"x"}'
curl -X POST http://127.0.0.1:3000/api/review-search-candidate \
  -H 'Content-Type: application/json' \
  -d '{"runId":"qa-f001","itemIndex":0,"decision":"accepted","reason":"x"}'
curl -X POST http://127.0.0.1:3000/api/review-search-candidate \
  -H 'Content-Type: application/json' \
  -d '{"runId":"qa-search-001","itemIndex":0,"decision":"accepted","reason":"  "}'
```

Expected: HTTP 400 in all three cases — unknown decision, RSS-run
candidate (`qa-f001` from the issue-1 plan, or any `news_feed` run), and
empty reason. No rows change.

### QA-5 — Search and RSS converge on one publication

```sh
node --env-file=.env --input-type=module -e "
import('./dist/src/db.js').then(async ({ database }) => {
  const { collect } = await import('./dist/src/import/service.js');
  const prisma = database();
  const url = 'https://www.deutschlandfunk.de/schule-qa-100.html';
  const run = await collect(prisma, 'qa-rss-001',
    '<rss><channel><language>de</language><item><title>Schule braucht mehr Personal</title>' +
    '<link>' + url + '</link><guid>schule-qa-100</guid></item></channel></rss>',
    { id: 'deutschlandfunk-nachrichten', publisher: 'Deutschlandfunk',
      url: 'https://www.deutschlandfunk.de/nachrichten-100.rss',
      defaultLanguage: 'de' },
    async () => ({ ok: false, reason: 'Unsupported format: QA stub' }));
  console.log(JSON.stringify({ status: run.status, valid: run.validCount }));
  console.log(JSON.stringify(await prisma.discovery.count({
    where: { publication: { originalUrl: url } } })));
  await prisma.\$disconnect();
})"
```

Expected: `completed`, and the shared URL keeps a single `publications`
row with two `discoveries` (one from `qa-search-001`, one from
`qa-rss-001`) — overlap is an extra encounter, not a duplicate.

### QA-6 — Replay is idempotent

Re-run the QA-2 script unchanged (same `runId`, same input), then re-run
the QA-3 accept.

Expected: identical run JSON (same counts); `runs`, `publications`,
`candidates`, `discoveries`, and `relevance_reviews` counts unchanged
before and after. Reusing `qa-search-001` with different results is
rejected with `Run ID already belongs to a different input`.

### QA-7 — Budget pause with a stubbed provider (no network)

The budget derives from live month-to-date usage, so this case passes
regardless of earlier QA runs:

```sh
node --env-file=.env --input-type=module -e "
import('./dist/src/db.js').then(async ({ database }) => {
  const { collectSearchQuery, countProviderCallsSince, monthStartUtc } =
    await import('./dist/src/import/service.js');
  const prisma = database();
  const fetchFn = async () => new Response(JSON.stringify({ results: [{
    url: 'https://www.tagesschau.de/schule-budget-100.html',
    title: 'Schule braucht mehr Personal' }] }), { status: 200 });
  const article = async () => ({ ok: false, reason: 'Unsupported format: QA stub' });
  const q = 'Bildung Schule Ausbildung Deutschland';
  const used = await countProviderCallsSince(prisma, 'tavily', monthStartUtc(new Date()));
  const opts = { apiKey: 'qa-stub-key', monthlyCallBudget: used + 1,
    fetchFn, fetchArticle: article };
  console.log(JSON.stringify(
    await collectSearchQuery(prisma, 'qa-budget-001', q, 'tavily', opts)));
  console.log(JSON.stringify(
    await collectSearchQuery(prisma, 'qa-budget-002', q, 'tavily', opts)));
  await prisma.\$disconnect();
})"
```

Expected: first call `completed` (`usage.calls: 1`); second call
`paused` with reason `Monthly tavily call budget exhausted (...);
provider paused, RSS collection continues`, and no `qa-budget-002` run
row exists. A `curl` collect of any RSS feed afterwards still completes.

### QA-8 — Live provider smoke test (opt-in, costs 1 call per provider)

Only with keys set (`EXA_API_KEY`, `TAVILY_API_KEY` in `.env`, never
committed) and no payment method attached to either account:

```sh
node --env-file=.env --input-type=module -e "
import('./dist/src/db.js').then(async ({ database }) => {
  const { collectSearchQuery, providerApiKey } =
    await import('./dist/src/import/service.js');
  const prisma = database();
  const article = async () => ({ ok: false, reason: 'Unsupported format: QA stub' });
  for (const [provider, runId] of [['exa', 'qa-live-exa'], ['tavily', 'qa-live-tavily']]) {
    console.log(provider, JSON.stringify(await collectSearchQuery(
      prisma, runId, 'Bildung Schule Ausbildung Deutschland', provider,
      { apiKey: providerApiKey(provider), limit: 3, fetchArticle: article })));
  }
  await prisma.\$disconnect();
})"
```

Expected: each call `completed` with `usage.calls: 1` and at most 3
candidates; run scopes record the provider; off-domain results (if any)
are flagged in `relevance_reviews` only via invalid candidates, never
resolved. Keep any measured precision/cost comparison private (see the
research doc's Tavily disclosure note); do not paste snippets or scores
into the repo.

### QA-9 — Data survives restarts

1. Stop the app (Ctrl-C), run `pnpm start` again: the QA runs,
   publications, and review decisions are identical.
2. `docker compose down` then `docker compose up -d --wait`, then
   `pnpm start`: everything is still listed (persistent Compose volume).

Expected: no data loss in either restart; replaying no run is required.

## Result log

| Case                           | Result (pass/fail) | Notes / actual values |
| ------------------------------ | ------------------ | --------------------- |
| QA-1 automated suite           |                    |                       |
| QA-2 fixture intake/provenance |                    |                       |
| QA-3 review accept/reject      |                    |                       |
| QA-4 review guards             |                    |                       |
| QA-5 RSS/search convergence    |                    |                       |
| QA-6 idempotent replay         |                    |                       |
| QA-7 budget pause (stubbed)    |                    |                       |
| QA-8 live smoke test (opt-in)  |                    | skipped without keys? |
| QA-9 restarts                  |                    |                       |

## Out of scope

Daily scheduling and missed-window recovery (issue #8), an admin-page
review queue and search-contribution display (with issue #10's inspection
scope), the 7-day paired provider trial from the research doc, provider
published-date semantics, and database-crash recovery. This plan covers
application-process restarts only, not a database crash or host reboot.
