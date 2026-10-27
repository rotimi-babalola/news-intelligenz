# News Intelligenz

News Intelligenz aims to help immigrants living in Germany understand parliamentary activity through English explanations grounded in official records. Its source scope is DIP proceedings, steps, and linked parliamentary documents across the institutions returned for selected electoral terms.

## Project status

The accepted [DIP-only decision](docs/adr/0007-dip-only-parliamentary-collection.md) removes editorial news feeds, news search, and article extraction from the target architecture. DIP collection, local retrieval, and lazy linked-PDF processing are implemented. The local runtime still exposes the earlier news collection and inspection paths; this documentation change does not disable them. Already collected news data stays available for internal inspection until a later cleanup exports or backs it up and removes news-only code and tables.

The [current architecture](docs/phase-1-architecture.md) describes the target. Older feed research, Phase 1 news criteria, and GitHub tickets that assume news collection are historical and need backlog review.

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
pnpm start
```

To use Neon Postgres instead of the Compose database, install the Neon CLI,
link the project, and deploy `neon.ts`:

```sh
npm i -g neon@latest
neon login
neon init -y --org-id <org-id> --project-id <project-id> --branch production \
  --services postgres
neon deploy
```

`neon deploy` writes `DATABASE_URL` and `DATABASE_URL_UNPOOLED` into `.env`.
Migrations use `DATABASE_URL_UNPOOLED`; application queries use the pooled
`DATABASE_URL`. PDFs stay in Cloudflare R2.

For the optional local DIP embedding model, start Ollama and download the
0.6B model once (about 639 MB):

```sh
docker compose --profile embeddings up -d --wait
docker compose exec ollama ollama pull qwen3-embedding:0.6b
```

Ollama listens only on `127.0.0.1:11434`. PostgreSQL uses pgvector; the
existing `news-data` volume is preserved when Compose recreates the database
container with the pgvector image. If local Ollama already uses port 11434,
set `OLLAMA_PORT=11435` in `.env` before starting Compose and the app. Once
DIP proceedings and steps are collected, `POST /api/drain-dip` embeds one
pending proceeding, step or extracted PDF passage per call; failed jobs retain
their standard retry state.

To import a selected term manually, set `BUNDESTAG_API_KEY` in `.env`
and use a new run ID for each collection:

```sh
curl -X POST http://127.0.0.1:3000/api/collect-dip \
  -H 'Content-Type: application/json' \
  -d '{"runId":"manual-21-1","electoralTerm":21,"source":"live"}'
```

Unattended collection uses the same code as a script, which is what the daily
deployment cron calls:

```sh
pnpm collect:dip
```

It collects `DIP_ELECTORAL_TERMS` (default `21,20`) for both endpoints and
exits non-zero when any term or endpoint fails; the untouched checkpoint means
the next run's overlap window retries it. Set `DIP_RUN_HOUR=7` on the deployed
cron and schedule two triggers, `0 5 * * *` and `0 6 * * *` (UTC): the
Berlin-hour guard lets only the one that lands on 07:00 Europe/Berlin collect,
so daylight saving needs no schedule edit. The script collects only — PDF
fetching and embedding remain separate drains.

To compare hosted embedding models before choosing one for production, see
[DIP embedding comparison](docs/dip-embedding-evaluation.md). The comparison
reindexes existing records under separate model identities, evaluates labeled
German and English queries, and uses a batch drain for backfill.

To replay a missed or failed period, set `DIP_BACKFILL_FROM` (and optionally
`DIP_BACKFILL_TO`, default now) and run `pnpm collect:dip`. An explicit window
bypasses the hour guard and is used verbatim for every scope; the checkpoint
still only moves forward. `DIP_PROCEEDING_CAP` optionally caps unique
proceedings per term.

Linked PDFs are extracted with [PyMuPDF](https://pymupdf.readthedocs.io/)
through `scripts/extract_pdf.py`, so the `python3` on `PATH` needs that package
once:

```sh
python3 -m pip install pymupdf
```

PDF fetching is independent of DIP collection: only references dated within the
previous 14 days are queued automatically, and `POST /api/drain-documents`
processes one queued document per call. Fetched PDF bytes are archived in
Cloudflare R2; extracted page text and overlapping LangChain passages stay in
PostgreSQL. Rows written before the move can be archived in place with
`pnpm backfill:documents` (`DRY_RUN=1`
reports without uploading); the command re-fetches from `source_url` only when
the row still holds no bytes. DIP data use is governed by the
[official terms](https://dip.bundestag.de/documents/nutzungsbedingungen_dip.pdf),
including source attribution, document reproduction rules, and possible
third-party rights.

Search the embedded DIP records with a German or English query:

```sh
curl -X POST http://127.0.0.1:3000/api/search-dip \
  -H 'Content-Type: application/json' \
  -d '{"query":"release of petroleum reserves","limit":10}'
```

`limit` defaults to 10 and is capped at 20. Results include the source entity,
API ID, current version number, title, available summary or step label, cosine
similarity score, and a DIP API source reference. A record appears only after
its current version's embedding job succeeds; extracted PDF passages appear as
`dokument` results carrying the matched passage, document reference, page and
chunk numbers, and original `pdf_url`. Only the latest fetched content variant
is searchable. Search requires the local Ollama model; collection and stored source records remain
available if it is offline.

Request a cited document on demand. This returns stored metadata and the
original `pdf_url` immediately, and raises an unprocessed document to the front
of the processing queue:

```sh
curl http://127.0.0.1:3000/api/documents/29701499
```

Repeated requests reuse the one processing job for that document revision.

### Legacy news runtime

The following RSS and fixture commands document paths still present in the
local runtime. They are outside the DIP-only target and will be removed in a
later cleanup. Do not use them as the new collection plan.

In another terminal, import the deterministic synthetic feed (no network):

```sh
curl -X POST http://127.0.0.1:3000/api/collect-fixture \
  -H 'Content-Type: application/json' \
  -d '{"runId":"f001"}'
```

Open [the local admin page](http://127.0.0.1:3000/admin). The fixture produces two valid
publications (German and English) and one rejected candidate.

Collection runs through the API, one call per feed, so each feed's results and
failures stay visible:

| Endpoint                           | Behaviour                                                    |
| ---------------------------------- | ------------------------------------------------------------ |
| `POST /api/collect-all`            | Fetches all nine public-news feeds, one run per feed         |
| `POST /api/collect`                | Fetches only the Deutschlandfunk Nachrichten feed by default |
| `POST /api/collect` with `feedUrl` | Imports any RSS 2.0 URL instead, stored under a per-host     |
|                                    | publisher scope with a distinct feed ID for operator QA      |
| `GET /api/verify-all`              | Checks all nine live endpoints without persisting anything   |
| `GET /api/verify?feedUrl=…`        | Checks one feed without persisting anything                  |

Request bodies and query strings are validated with Zod; invalid requests get
HTTP 400 with the details, while collection failures surface as HTTP 500.

Each run appears alongside the others and the
page labels each input. Select a run to inspect its
candidates, validation errors and discovery history. The page shows up to 100
records per section; all records remain in PostgreSQL. Extracted article text is
versioned; feed descriptions are never retained. The app is bound to `127.0.0.1` and refuses
non-local hosts; deployed
authentication and hosting belong to later tickets.

`pnpm start` (and `pnpm dev`) applies the Prisma migrations
automatically. Use `pnpm db:migrate` to apply them separately. `DATABASE_URL`
and `PORT` can be set in `.env` or the environment. The Compose credentials are
local development defaults.

```sh
# Replay: returns the stored result without changing rows
curl -X POST http://127.0.0.1:3000/api/collect-fixture \
  -H 'Content-Type: application/json' \
  -d '{"runId":"f001"}'
# New encounter: same publications, new discoveries
curl -X POST http://127.0.0.1:3000/api/collect-fixture \
  -H 'Content-Type: application/json' \
  -d '{"runId":"f002"}'
```

A run ID identifies one immutable feed input. Changed XML requires a new run ID;
a live feed that changed between snapshots is a different input, so use a fresh
run ID per live collect. Candidate counts count feed entries; discovery counts
count distinct publications per feed/run. Publication identity uses
publisher-scoped GUIDs or exact original URLs, without headline matching.
Conflicting identity evidence rejects the candidate for inspection. Permitted
article text is fetched and versioned, and resolved URLs become identity evidence.

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

The integration test creates and removes its own isolated schema. It collects
through the API in separate processes, restarts the app, compares persisted rows and
rendered pages, and checks idempotent/concurrent replay, distinct discoveries,
identity conflicts, transaction rollback and HTML escaping. It does not stop
your database. Database outages roll back the current transaction; retry the same
run after restoring connectivity. Malformed feeds receive a persisted failed run
result; SQL/connection failures are reported with a 500 response and roll
back all writes. Durable retry jobs are deferred.

## Phase 1: parliamentary collection

The accepted target collects DIP parliamentary activity, not editorial news. It keeps
proceedings, steps, observed versions, document references, source provenance,
processing jobs, and checkpoints in PostgreSQL. Selected electoral terms cover all
proceeding types and the institutions returned by DIP. Local imports cap unique
proceedings at 1,000 across runs; nonlocal environments import the full selected
scope. New terms are added explicitly while earlier selections remain monitored.

Collection is planned for 07:00 Europe/Berlin with six hours of overlap and
independent recovery for the two DIP endpoints. No scheduler is wired in the
current repository. `POST /api/collect-dip` can be called manually with a
configured `BUNDESTAG_API_KEY`, a unique `runId`, an `electoralTerm`, and
`"source":"live"`. DIP records persist even if embedding or PDF processing
later fails. The admin at `/admin/dip` inspects records, document references,
jobs, and failures.

Multilingual retrieval uses local Ollama and pgvector. Linked PDFs are queued
independently for recent document dates or on demand. Future English explainers
will use proceeding dossiers with claims cited to steps or document pages;
generated answers and the reader interface are outside this phase.

Phase 1 acceptance is the [DIP verification criteria](docs/dip-design-notes.md#verification-criteria)
plus seven consecutive scheduled DIP runs once scheduling exists. The original
RSS/search sample and contribution metrics are superseded.

## Documentation

- [Current architecture](docs/phase-1-architecture.md) — DIP collection,
  processing, reliability, and acceptance.
- [DIP design notes](docs/dip-design-notes.md) — source scope and verification.
- [ADR 0007](docs/adr/0007-dip-only-parliamentary-collection.md) — why the
  project stopped targeting editorial news.
- [ADR 0008](docs/adr/0008-shared-read-only-mcp-access.md) — invited agent access
  to the shared DIP corpus.
- [ADR 0009](docs/adr/0009-r2-for-dip-pdf-variants.md) — R2 archive for fetched
  PDF variants.
- [Domain glossary](CONTEXT.md) — parliamentary terms.
- [ADR 0006](docs/adr/0006-proceeding-centric-explainers.md) — future grounded
  English explanations.
- [Original design interview](docs/phase-1-design-notes.md), [feed catalog](docs/phase-1-feed-catalog.md),
  and [feed verification](docs/launch-feed-verification.md) — historical news
  design and implementation evidence.

The older GitHub Phase 1 tickets still include RSS/search assumptions. Review
them against ADR 0007 before scheduling or deploying the next increment.
[Issue #42](https://github.com/rotimi-babalola/news-intelligenz/issues/42)
tracks removal of legacy news code and the later backed-up data and schema cleanup.
