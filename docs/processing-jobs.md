# Processing jobs and retry policy

Collection intake and downstream processing are separate durable stages.
Intake (run, candidates, one job per parse-valid candidate) commits in a
single transaction: the discovery handoff. Each job's publication,
identifier, discovery-encounter and candidate-link writes commit in their
own transaction: processing completion. A crash between the two resumes
from the pending jobs; replaying a settled run returns the stored row.

## Retry budget

- At most 5 attempts per job (`max_attempts`, reset to 0 on deliberate retry).
- Failed attempts back off exponentially from 30s, capped at one hour.
- A claimed job holds a 5-minute lease. A worker that dies mid-processing
  leaves a stale lease; any worker can reclaim it (safe claiming via
  `FOR UPDATE SKIP LOCKED`), and `requeueStaleClaims` makes stale claims
  immediately reclaimable on restart.
- Attempt history is durable in `job_attempts`; the job row keeps the last
  error for inspection.

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
enqueues one `embed_document` job per non-empty page. Identical bytes are reused
without extraction; changed bytes become a new retained variant, and only the
latest variant is searchable. A model outage therefore retries the embedding
job, not the download.
`POST /api/drain-documents` processes one document job per call; `POST
/api/drain-dip` processes one proceeding, step or extracted-page embedding.

Priority (`processing_jobs.priority`, higher first) lets `GET
/api/documents/:referenceId` raise unprocessed work ahead of older background
jobs. Stale claims requeue with an epoch `next_attempt_at`, so restart recovery
does not depend on the app and PostgreSQL clocks agreeing.

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
