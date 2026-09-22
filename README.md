# News Intelligenz

News Intelligenz aims to help immigrants living in Germany understand the country's news and government activity through English explanations. Coverage focuses on politics and everyday life, including employment, housing, healthcare and education—not only immigration.

## Project status

Phase 1 design is confirmed and its implementation is tracked in [GitHub issues labelled Phase 1](https://github.com/rotimi-babalola/news-intelligenz/issues?q=is%3Aissue%20label%3A%22Phase%201%22). The first local slice collects the Deutschlandfunk Nachrichten RSS feed (metadata only) and a synthetic fixture into PostgreSQL and provides a read-only inspection page. Full-text retention remains disabled pending the feed's usage terms; see the [feed verification report](docs/launch-feed-verification.md).

The confirmed [DIP architecture amendment](docs/dip-design-notes.md) replaces Bundestag RSS with parliamentary proceedings and steps. The planned behavior below reflects the amendment; DIP is not implemented yet.

## Run locally

Requirements: Node.js **24 LTS**, pnpm **10.18.3**, and Docker with Compose.
Run commands from the repository root. Use `nvm install` / `nvm use` if you manage
Node through nvm. The runtime and Prisma approach are recorded in
[ADR 0003](docs/adr/0003-local-runtime-and-database-access.md).

```sh
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait
pnpm build
pnpm collect-fixture f001   # Deterministic synthetic feed (no network)
pnpm start
```

Open [the local admin page](http://127.0.0.1:3000). The fixture produces two valid
publications (German and English) and one rejected candidate. `pnpm collect <run-id>`
fetches the live Deutschlandfunk Nachrichten feed; `pnpm collect <run-id> [feed-url]`
imports any RSS 2.0 URL instead, stored under a per-host publisher scope with a
distinct feed ID for operator QA. Each run appears alongside the others and the
page labels each input. Select a run to inspect its
candidates, validation errors and discovery history. The page shows up to 100
records per section; all records remain in PostgreSQL. No article text or feed
descriptions are retained. The admin is bound to `127.0.0.1`; deployed
authentication and hosting belong to later tickets.

Collection start (`collect`/`collect-fixture`) applies the Prisma migrations
automatically. Use `pnpm db:migrate` to apply them separately. `DATABASE_URL`
and `PORT` can be set in `.env` or the environment. The Compose credentials are
local development defaults.

```sh
pnpm collect-fixture f001       # Replay: returns the stored result without changing rows
pnpm collect-fixture f002       # New encounter: same publications, new discoveries
```

A run ID identifies one immutable feed input. Changed XML requires a new run ID;
a live feed that changed between snapshots is a different input, so use a fresh
run ID per live collect. Candidate counts count feed entries; discovery counts
count distinct publications per feed/run. Publication identity uses
publisher-scoped GUIDs or exact original URLs, without headline matching.
Conflicting identity evidence rejects the candidate for inspection. Redirect
resolution and extraction are later work.

Stop the admin with Ctrl-C. `docker compose down` stops PostgreSQL while keeping
its named volume; `docker compose up -d --wait` restores access to the saved data.
Do not add `--volumes` unless you intend to delete that data. The schema is owned
by Prisma; `pnpm exec prisma migrate reset` resets a disposable database to the
migration history.

### Verification

```sh
pnpm test
pnpm test:integration # Requires the running local PostgreSQL service and .env
pnpm check
pnpm format
```

The integration test creates and removes its own isolated schema. It runs the
collector in separate processes, restarts the admin, compares persisted rows and
rendered pages, and checks idempotent/concurrent replay, distinct discoveries,
identity conflicts, transaction rollback and HTML escaping. It does not stop
your database. Database outages roll back the current transaction; retry the same
run after restoring connectivity. Malformed feeds receive a persisted failed run
result; SQL/connection failures are reported by the operator command and roll
back all writes. Durable retry jobs are deferred.

## Phase 1: news collection

The first deliverable is a fault-tolerant pipeline that collects, validates, processes and stores news with traceable discovery history. It includes an internal admin tool for one operator. English explainers and a reader-facing experience come later.

### Sources

- **Nine public-news RSS feeds:** Tagesschau all updates and eight Deutschlandfunk feeds. See the [feed catalog](docs/phase-1-feed-catalog.md).
- **DIP parliamentary activity:** `/vorgang` proceedings and `/vorgangsposition` steps, covering all types and institutions returned for the selected electoral terms. Import the full current term initially; add new terms explicitly and keep previous selections monitored.
- **Targeted search agents:** six fixed German queries covering politics/legislation, employment/economy, housing, healthcare, education and immigration. Initial searches are restricted to `tagesschau.de` and `deutschlandfunk.de`.

All valid items from configured feeds are eligible without relevance filtering. Search results are assessed for relevance to Germany, with uncertain candidates held for manual review. German and English source material is preserved without translation.

### Planned behaviour

- Collect daily at **07:00 Europe/Berlin**, with six hours of overlap and independent recovery progress for each feed, search query, and DIP endpoint/scope.
- Store publications, text versions, parliamentary records and their versions, discoveries, processing jobs and review decisions in **PostgreSQL**.
- Retain DIP metadata, available summaries, steps, and document references. Preserve changed record states separately from articles; defer linked document-text retrieval and automatic links to reporting.
- Extract article text from linked pages where source permissions allow; retain permitted metadata and original links when extraction fails or a format is unsupported.
- Deduplicate the same publication using identifiers and resolved URLs while keeping different publishers' reporting separate.
- Preserve changed article text as versions, recheck recently discovered publications and refresh older ones when rediscovered.
- Recover interrupted processing through durable jobs and retries, support manual backfills and expose unresolved gaps and failures.
- Provide an internal inspection page, relevance review and reversible duplicate merges. Protect deployed admin access with Basic Auth over HTTPS.
- Inspect proceedings, institution-labeled steps, retained versions, document references, and collection outcomes in dedicated admin views.
- Measure source contributions, extraction outcomes, search relevance and resource usage. Explore free tiers first and pause affected providers when allowances run out.

The first feed's metadata format is verified and live metadata collection is
enabled; full-text retention remains unresolved pending the feed's usage terms.
Node.js 24 and Prisma with PostgreSQL are selected for the local runtime.
Other feed endpoints, search provider and hosting selections remain future work.
DIP authentication, permissions, limits, and live synchronization behavior require verification before enabling collection.

### Completion criteria

Phase 1 requires seven consecutive scheduled runs, demonstrated persistence and recovery, idempotent replays, working review flows, a manually checked sample of 30 items, and a report of search's contribution beyond RSS. See the [full acceptance criteria](docs/phase-1-design-notes.md#agreed-completion-criteria).
The [DIP criteria](docs/dip-design-notes.md#verification-criteria) add initial import, pagination recovery, independent step updates, version history, and electoral-term transitions.

## Documentation

| Document                                                                             | Purpose                                                        |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| [Phase 1 architecture](docs/phase-1-architecture.md)                                 | Agreed scope, collection flow and operational behaviour        |
| [Design notes](docs/phase-1-design-notes.md)                                         | Decisions, acceptance criteria and unresolved factual checks   |
| [DIP amendment](docs/dip-design-notes.md)                                            | Parliamentary collection decisions and verification criteria   |
| [Feed catalog](docs/phase-1-feed-catalog.md)                                         | Exact launch feed URLs                                         |
| [Domain glossary](CONTEXT.md)                                                        | Shared terminology for publications, versions and discoveries  |
| [ADR: publication versions](docs/adr/0001-preserve-publication-versions.md)          | Why historical article text is retained                        |
| [ADR: PostgreSQL storage and jobs](docs/adr/0002-postgresql-for-storage-and-jobs.md) | Why persistent data and durable jobs share a database          |
| [ADR: local runtime](docs/adr/0003-local-runtime-and-database-access.md)             | Node.js 24 and Prisma with PostgreSQL 17                       |
| [Launch feed verification](docs/launch-feed-verification.md)                         | First live feed, terms and retention distinction               |
| [Database tables](docs/database-tables.md)                                           | Collection schema: runs, publications, candidates, discoveries |
| [Issue #1 QA plan](docs/issue-1-qa-plan.md)                                          | Manual end-to-end checks: import URL, inspect DB, review admin |

## Implementation roadmap

Start with [issue #1: collect and inspect one RSS feed locally](https://github.com/rotimi-babalola/news-intelligenz/issues/1), then follow the **Blocked by** references in the [Phase 1 issues](https://github.com/rotimi-babalola/news-intelligenz/issues?q=is%3Aissue%20label%3A%22Phase%201%22). Each issue includes a description and acceptance criteria.

The tickets incorporate the confirmed DIP amendment. [Issue #2](https://github.com/rotimi-babalola/news-intelligenz/issues/2) covers the nine public-news RSS feeds. Parliamentary work proceeds through [DIP import and record versions (#14)](https://github.com/rotimi-babalola/news-intelligenz/issues/14), [incremental synchronization (#15)](https://github.com/rotimi-babalola/news-intelligenz/issues/15), and [parliamentary inspection (#16)](https://github.com/rotimi-babalola/news-intelligenz/issues/16). Scheduling, monitoring, deployment, and acceptance tickets include the corresponding dependencies and verification criteria.

Future phases may add English explainers, coverage of all 16 state parliaments, additional publishers and reader-facing features. Event clustering, embeddings and semantic search are outside Phase 1.
