# Database tables

The schema is owned by Prisma: `prisma/schema.prisma` is the source of truth,
`prisma/migrations` holds the versioned history, and the typed client is
generated into `src/generated/prisma`. Model fields use camelCase; `@@map` and
`@map` map them to snake_case tables and columns in PostgreSQL. All dates are
`timestamptz`. Feed excerpts (RSS descriptions) are never stored; retained
article text always comes from fetching the directly linked resource.

One collection run writes its intake (run, candidates, processing jobs)
inside a single transaction guarded by the session-level advisory lock
`pg_advisory_xact_lock(8135421)`, so concurrent identical runs serialize
and replay is safe. Downstream processing commits separately, one
transaction per job; publication identity resolution takes a per-publisher
advisory lock so concurrent first encounters converge on one publication.
Integration tests run the same migrations into an isolated schema per test
run via the driver adapter's `schema` option; raw job-claim SQL qualifies
its tables with that schema explicitly.

## runs

One row per collection attempt. The primary key is the operator-chosen run ID,
which identifies one immutable feed input: reusing an ID against a different
input hash or feed is rejected, while replaying identical input returns the
stored row.

| Field          | Column          | Type         | Null | Default     | Notes                                                                    |
| -------------- | --------------- | ------------ | ---- | ----------- | ------------------------------------------------------------------------ |
| `id`           | `id`            | text, PK     | no   | —           | Operator label, 1–200 chars, e.g. `live-dlf-20260922`                    |
| `feedId`       | `feed_id`       | text         | no   | —           | Source key for every source kind: feed ID, search query, or DIP endpoint |
| `sourceKind`   | `source_kind`   | `SourceKind` | no   | `news_feed` | `news_feed`, `search_query`, or `dip_endpoint`                           |
| `sourceScope`  | `source_scope`  | jsonb        | yes  | —           | Selected scope: allowed domains, electoral term, or null for feeds       |
| `inputHash`    | `input_hash`    | text         | no   | —           | SHA-256 of the exact collected XML                                       |
| `startedAt`    | `started_at`    | timestamptz  | no   | `now()`     |                                                                          |
| `completedAt`  | `completed_at`  | timestamptz  | yes  | —           | Set when the run finishes; null while `running`                          |
| `status`       | `status`        | `RunStatus`  | no   | —           | `running`, `completed`, or `failed`                                      |
| `validCount`   | `valid_count`   | integer      | no   | `0`         | Candidates without validation errors                                     |
| `invalidCount` | `invalid_count` | integer      | no   | `0`         | Candidates with validation errors                                        |
| `error`        | `error`         | text         | yes  | —           | Parse failure message for `failed` runs                                  |

## publications

One row per distinct publication, deduplicated across runs by publisher-scoped
identity (exact original URL or feed `guid`). Headline, URL and date updates
from later discoveries overwrite the row; discovery history stays in
`discoveries`. Identity conflicts (one publisher's identifiers pointing at two
publications) reject the candidate instead of merging.

| Field                 | Column                 | Type                  | Null | Default         | Notes                                                               |
| --------------------- | ---------------------- | --------------------- | ---- | --------------- | ------------------------------------------------------------------- |
| `id`                  | `id`                   | uuid, PK              | no   | —               | Random UUID, or the reused ID of a rediscovered publication         |
| `publisher`           | `publisher`            | text                  | no   | —               | `Deutschlandfunk`, `Synthetic Bundestag fixture`, or an import host |
| `headline`            | `headline`             | text                  | no   | —               | Original German/English text, untranslated                          |
| `originalUrl`         | `original_url`         | text                  | no   | —               | Exact source link                                                   |
| `publishedAt`         | `published_at`         | timestamptz           | yes  | —               | Null when the feed gives no usable date                             |
| `language`            | `language`             | `Language`            | no   | —               | `de` or `en`; BCP-47 tags normalize to the primary subtag           |
| `contentAvailability` | `content_availability` | `ContentAvailability` | no   | `metadata_only` | `full_text` once an extraction stores a version                     |
| `extractionError`     | `extraction_error`     | text                  | yes  | —               | Latest extraction failure; null after a successful extraction       |
| `firstDiscoveredAt`   | `first_discovered_at`  | timestamptz           | no   | `now()`         | Set on creation only                                                |
| `lastDiscoveredAt`    | `last_discovered_at`   | timestamptz           | no   | `now()`         | Bumped on every rediscovery                                         |

## publication_identifiers

The identity evidence for publications. The composite primary key
`(publisher, kind, value)` enforces publisher-scoped uniqueness.

| Field           | Column           | Type                         | Null | Default | Notes                                                 |
| --------------- | ---------------- | ---------------------------- | ---- | ------- | ----------------------------------------------------- |
| `publisher`     | `publisher`      | text, PK                     | no   | —       | Scopes the identity; different publishers never merge |
| `kind`          | `kind`           | `IdentifierKind`             | no   | —       | `url` or `guid`                                       |
| `value`         | `value`          | text, PK                     | no   | —       | Exact URL or feed `guid`                              |
| `publicationId` | `publication_id` | uuid, FK → `publications.id` | no   | —       |                                                       |

## publication_versions

One row per successive change in extracted article text under a publication.
Text matching the latest version creates no row; a later return to earlier text
does create a new version. The redirect-resolved
final URL is recorded per version and learned as a `url` identifier.

| Field           | Column           | Type                         | Null | Default  | Notes                                      |
| --------------- | ---------------- | ---------------------------- | ---- | -------- | ------------------------------------------ |
| `id`            | `id`             | uuid, PK                     | no   | `uuid()` |                                            |
| `publicationId` | `publication_id` | uuid, FK → `publications.id` | no   | —        |                                            |
| `versionNo`     | `version_no`     | integer                      | no   | —        | 1-based, unique per publication            |
| `text`          | `text`           | text                         | no   | —        | Fetched article text, never a feed excerpt |
| `textHash`      | `text_hash`      | text                         | no   | —        | SHA-256 of `text`                          |
| `finalUrl`      | `final_url`      | text                         | no   | —        | Redirect-resolved article URL              |
| `fetchedAt`     | `fetched_at`     | timestamptz                  | no   | `now()`  |                                            |

## candidates

Every feed entry of a run, valid or not, with its validation errors. The
composite primary key is `(run_id, item_index)`, so replays return identical
rows.

| Field           | Column           | Type                         | Null | Default | Notes                                                       |
| --------------- | ---------------- | ---------------------------- | ---- | ------- | ----------------------------------------------------------- |
| `runId`         | `run_id`         | text, PK/FK → `runs.id`      | no   | —       |                                                             |
| `itemIndex`     | `item_index`     | integer, PK                  | no   | —       | Zero-based position in the feed                             |
| `metadata`      | `metadata`       | jsonb                        | no   | —       | Retained headline, language, source ID, dates, original URL |
| `errors`        | `errors`         | jsonb                        | no   | —       | Validation messages; empty means accepted                   |
| `publicationId` | `publication_id` | uuid, FK → `publications.id` | yes  | —       | Null for rejected candidates                                |

## discoveries

The distinct encounters between runs and publications: one row per
(run, publication) pair, recording that this run surfaced this publication.
The composite primary key is `(run_id, publication_id)`.

| Field           | Column           | Type                            | Null | Default | Notes |
| --------------- | ---------------- | ------------------------------- | ---- | ------- | ----- |
| `runId`         | `run_id`         | text, PK/FK → `runs.id`         | no   | —       |       |
| `publicationId` | `publication_id` | uuid, PK/FK → `publications.id` | no   | —       |       |
| `discoveredAt`  | `discovered_at`  | timestamptz                     | no   | `now()` |       |

## processing_jobs

Durable downstream work, one row per (run, candidate, operation), keyed by
the `dedupe_key` unique constraint so replays never enqueue twice. Claiming
is a single atomic `UPDATE ... FOR UPDATE SKIP LOCKED`: exactly one worker
wins each ready job. See [processing jobs](processing-jobs.md) for the
retry policy.

| Field            | Column             | Type                 | Null | Default   | Notes                                                           |
| ---------------- | ------------------ | -------------------- | ---- | --------- | --------------------------------------------------------------- |
| `id`             | `id`               | uuid, PK             | no   | `uuid()`  |                                                                 |
| `dedupeKey`      | `dedupe_key`       | text, UQ             | no   | —         | `<runId>:<itemIndex>:<operation>`                               |
| `sourceKind`     | `source_kind`      | `SourceKind`         | no   | —         | `news_feed`, `search_query`, or `dip_endpoint`                  |
| `sourceKey`      | `source_key`       | text                 | no   | —         | Feed ID, query, or endpoint                                     |
| `sourceScope`    | `source_scope`     | jsonb                | yes  | —         | Allowed domains, electoral term, or null                        |
| `runId`          | `run_id`           | text, FK → `runs.id` | no   | —         |                                                                 |
| `itemIndex`      | `item_index`       | integer              | yes  | —         | Candidate position; null for run-scoped work                    |
| `operation`      | `operation`        | text                 | no   | —         | `resolve_publication`; DIP operations arrive with later tickets |
| `payload`        | `payload`          | jsonb                | no   | —         | Operation input, e.g. publisher snapshot                        |
| `status`         | `status`           | `JobStatus`          | no   | `pending` | `pending`, `claimed`, `retrying`, `succeeded`, or `exhausted`   |
| `attempts`       | `attempts`         | integer              | no   | `0`       | Incremented at claim; reset by deliberate retry                 |
| `maxAttempts`    | `max_attempts`     | integer              | no   | `5`       | Bounded retries                                                 |
| `nextAttemptAt`  | `next_attempt_at`  | timestamptz          | no   | `now()`   | Backoff or provider `Retry-After` delay                         |
| `claimedAt`      | `claimed_at`       | timestamptz          | yes  | —         |                                                                 |
| `claimedBy`      | `claimed_by`       | text                 | yes  | —         | Worker ID                                                       |
| `leaseExpiresAt` | `lease_expires_at` | timestamptz          | yes  | —         | 5-minute claim lease; expiry makes the job reclaimable          |
| `lastError`      | `last_error`       | text                 | yes  | —         | Inspectable failure, preserved on exhaustion                    |

## job_attempts

Durable per-attempt state: one row per (`job_id`, `attempt_no`), opened at
claim and closed with the outcome (`succeeded`, `retrying`, `exhausted`)
and error. Survives worker restarts alongside the job row.

## relevance_reviews

Agent and operator relevance decisions for search candidates: one row per
(run, candidate). The agent records `accepted` or `uncertain` at intake; only
accepted candidates enqueue publication resolution. Uncertain candidates stay
excluded until the operator records `accepted` (routes into processing) or
`rejected` (stays excluded but inspectable). RSS candidates never get a row.

| Field       | Column       | Type                | Null | Default | Notes                                  |
| ----------- | ------------ | ------------------- | ---- | ------- | -------------------------------------- |
| `runId`     | `run_id`     | text, PK            | no   | —       |                                        |
| `itemIndex` | `item_index` | integer, PK         | no   | —       | Candidate position                     |
| `decision`  | `decision`   | `RelevanceDecision` | no   | —       | `accepted`, `uncertain`, or `rejected` |
| `reason`    | `reason`     | text                | no   | —       | Assessment or review justification     |
| `decidedBy` | `decided_by` | text                | no   | —       | `agent` or `operator`                  |
| `decidedAt` | `decided_at` | timestamptz         | no   | `now()` |                                        |

## Enums

- `RelevanceDecision`: `accepted`, `uncertain`, `rejected`.
- `ParliamentaryEntity`: `vorgang`, `vorgangsposition`.

## Parliamentary records

DIP proceedings and steps live apart from news publications. Identity is the
DIP entity type plus its numeric-string API ID (`proceedings.api_id`,
`proceeding_steps.api_id`); steps link to proceedings through the plain
`proceeding_steps.proceeding_id` column with no foreign key, so steps whose
parent has not been observed are retained instead of rejected. Document dates
(`document_date`), source update timestamps (`source_updated_at`) and
observation times (`observed_at`) are stored separately. A changed observation
adds a version row; an unchanged observation adds nothing (and a return to
earlier text counts as a new version, mirroring publications).

| Table                       | Key                             | Notes                                                                                                                                                                               |
| --------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proceedings`               | `api_id`                        | Current proceeding state; `latest_version_no` points at the newest row in `proceeding_versions`                                                                                     |
| `proceeding_versions`       | (`proceeding_id`, `version_no`) | Observed snapshots with `content_hash`, `snapshot`, `source_updated_at`, `observed_at`, and observing `run_id`                                                                      |
| `proceeding_steps`          | `api_id`                        | Current step state with `institution` (`BT`/`BR`/`BV`/`EK`); indexed `proceeding_id` parent link                                                                                    |
| `proceeding_step_versions`  | (`step_id`, `version_no`)       | Observed step snapshots, same shape as proceeding versions                                                                                                                          |
| `document_references`       | `step_id`                       | Current `fundstelle` per step: `reference_id`, `document_number`, `pdf_url`, `document_date`, plus the denormalized parent `proceeding_id`; history lives in step version snapshots |
| `parliamentary_discoveries` | (`run_id`, `entity`, `api_id`)  | Distinct encounters; replaying a run reuses the row, a new run adds one                                                                                                             |
| `dip_checkpoints`           | (`endpoint`, `electoral_term`)  | Durable per-endpoint/scope progress; advances only after all pages of a window are stored                                                                                           |

- `RunStatus`: `running`, `completed`, `failed`.
- `Language`: `de`, `en`.
- `IdentifierKind`: `guid`, `url`.
- `ContentAvailability`: `metadata_only`, `full_text` (`full_text` is defined for
  later tickets; nothing writes it yet).
- `SourceKind`: `news_feed`, `search_query`, `dip_endpoint`.
- `JobStatus`: `pending`, `claimed`, `retrying`, `succeeded`, `exhausted`.

## What is deliberately absent

There is no table for feed descriptions or users. Publication
identity uses exact identifiers only; there is no headline matching, redirect
resolution, or cross-publisher merging.
