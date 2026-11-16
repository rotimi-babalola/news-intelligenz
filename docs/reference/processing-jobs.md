# Processing jobs and retry policy

Collection intake and downstream processing are separate durable stages.
Intake (run, candidates, one job per parse-valid candidate) commits in a
single transaction: the discovery handoff. Each job's publication,
identifier, discovery-encounter and candidate-link writes commit in their
own transaction: processing completion. A crash between the two resumes
from the pending jobs; replaying a settled run returns the stored row.

## Retry budget

- At most 5 attempts per job (`max_attempts`).
- A failure the source cannot stop producing exhausts on the first attempt
  instead of spending the budget: `PermanentJobError` marks it, and
  `isExhausting` in `src/jobs/policy.ts` decides. `process_document` raises it
  for `HTTP 404`/`HTTP 410` and for a PDF declared over the size bound, since
  neither can improve by retrying. Everything else — 5xx, timeouts, blocked
  destinations, unreadable PDFs — keeps the full budget.
- Failed attempts back off exponentially from 30s, capped at one hour.
- A claimed job holds a 5-minute lease. A worker that dies mid-processing
  leaves a stale lease; any worker can reclaim it (safe claiming via
  `FOR UPDATE SKIP LOCKED`), and every worker pass reclaims expired leases
  before claiming, so recovery is the same whichever entry point runs.
- Attempt history is durable in `job_attempts`; the job row keeps the last
  error for inspection.
- `attempts` is append-only. A deliberate retry raises `max_attempts` by its
  current value (`retryExhausted`) and never resets the counter, because each
  claim inserts `job_attempts` at `attempts + 1`; resetting the counter
  collides with existing attempt rows.

## Rate limits

- Feed fetches translate HTTP 429 plus `Retry-After` (seconds or HTTP date,
  default 60s) into a `RateLimitedError`.
- Failing a job with that error schedules the next attempt after the
  provider's delay instead of the regular backoff.
- One source's backoff never blocks others: claiming always picks the
  earliest ready job across sources, and `collectAll` records a per-feed
  failure while continuing with the remaining feeds.

## DIP document jobs

DIP collection stores the `fundstelle` reference and enqueues document work for
references dated within the previous 14 days; it never fetches PDF bytes.
`process_document` jobs are deduped per referenced document revision
(`fundstelle.id`, `pdf_url`, `datum`), so two steps citing one Drucksache share
a job and the background hot subset and an on-demand request converge on the
same row.

A document job fetches the bytes, archives them in R2 under a key derived from
the reference ID and SHA-256 byte hash, extracts page text with PyMuPDF and
enqueues one `embed_document` job per extracted passage. Identical bytes are
reused without extraction; changed bytes become a new retained variant, and only
the latest variant is searchable. A model outage therefore retries the embedding
job, not the download.
`POST /api/drain-documents` processes one document job per call; `POST
/api/drain-dip` processes one proceeding, step or extracted-page embedding.

The 14-day rule leaves older references unqueued. `pnpm
backfill:document-jobs` queues every older eligible reference that has no
current processed variant (`DRY_RUN=1` reports counts without writing). It
prints per-batch progress and accepts `RESUME_FROM=<referenceId>` after a
dropped connection; job creation is idempotent, so replaying the interrupted
batch is safe. It only enqueues; the cron or `pnpm drain:dip` still fetches,
extracts and embeds. Re-running is safe because current variants are skipped and
job dedupe keys are unchanged.

Priority (`processing_jobs.priority`, higher first) lets `GET
/api/documents/:referenceId` raise unprocessed work ahead of older background
jobs. Stale claims requeue with an epoch `next_attempt_at`, so restart recovery
does not depend on the app and PostgreSQL clocks agreeing.

### Size bound and memory

`MAX_PDF_BYTES` is 600 MB in `src/dip/constants.ts`. It is not a content
judgement: the extract shape peaks at about 2.5x the source size, so the bound
tracks the memory of the cron plan it runs on (2 GB at the time of writing,
measured on Drucksache 21/7300 — 275,730,215 bytes, 3,561 pages, 705 MB peak).
Raising the bound without raising the plan turns an oversized document into an
out-of-memory crash instead of a rejected job. Re-measure before changing
either.

Streaming is not an alternative on this platform: `pdftotext` buffers stdin
(819 MB peak on the same file, against 232 MB reading from a file), and Render
cron jobs have no disk for the file path to use.

## Drain schedule

`news-intelligenz-pdf-emb-cron` runs `pnpm drain:dip` every 15 minutes on a
`1c-2g` cron. Its behaviour comes from environment variables, not the repo:

| Variable                     | Value | Effect                                                   |
| ---------------------------- | ----- | -------------------------------------------------------- |
| `DIP_DOCUMENT_DRAIN_CAP`     | 100   | document jobs per run                                    |
| `DIP_EMBEDDING_DRAIN_CAP`    | 2000  | embedding jobs per run (about 7 minutes, 8,000 per hour) |
| `DIP_EMBEDDING_REINDEX_ONLY` | unset | set to `1` to drain only reindex work                    |

The script exits non-zero when a job is retrying, or when a job exhausted for a
reason other than a permanent source failure. Permanent exhaustion is counted
separately (`permanent`) so a dead upstream link, which no retry can fix, does
not fail the run and page an operator.

## Sources

Jobs carry a generic source identity (`source_kind`, `source_key`,
`source_scope`): `news_feed` (key is the feed ID), `search_query` (key is
the query, scope holds allowed domains), `dip_endpoint` (key is the
endpoint, scope holds the electoral term). Runs keep `feed_id` as the
source key for every kind with `source_kind` defaulting to `news_feed`, so
existing rows needed no migration.

## Operator recovery

The local admin `#jobs` section shows pending (including claimed),
retrying and exhausted counts plus the retrying/exhausted rows with their
last errors. Retrying jobs resume on their own; each exhausted row has a
Retry button that resets its budget and immediately reprocesses its run.

## Service layout

`src/import/service.ts` holds only the service operations (intake,
review, job processing, collection, verification) plus the job-operation
constants. Shared helpers live in `src/import/util.ts`, shared types in
`src/import/types.ts` (re-exported from the service so existing imports
keep working). Future services follow the same split: `service.ts`
orchestrates repositories and jobs; anything reusable or purely
descriptive moves to `util.ts` / `types.ts`.
