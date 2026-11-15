# Application state machines

This inventory covers persisted states and the operational states that drive them. Tables describe transitions implemented today. A state marked _derived_ is calculated from rows rather than stored as an enum. Source paths are evidence; the regression tests are in `test/jobs.integration.ts`.

## Runs and collection progress

`Run.status` is `running | completed | failed` (`prisma/schema.prisma`). News and search intake create `running` runs with candidate and resolve-job handoff in one transaction (`src/import/service.ts`). DIP page collection creates a `running` run, commits page batches, and finishes it with a checkpoint (`src/dip/collect.ts`).

| From      | Event                       | To                  | Invariant                                                                       |
| --------- | --------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| absent    | Intake or DIP scan starts   | running             | A run ID binds to one input hash and source.                                    |
| running   | News/search jobs settle     | completed or failed | `completedAt` is set after no open jobs; parse errors select failed.            |
| running   | DIP window finishes         | completed           | All pages are stored before the checkpoint advances.                            |
| running   | DIP page/fetch error        | failed              | Earlier committed page batches remain; the checkpoint does not advance.         |
| failed    | Same DIP run ID is replayed | completed or failed | Candidate indexes are replayed; record/version/discovery writes are idempotent. |
| completed | Same input is replayed      | completed           | No new intake or DIP page work.                                                 |

The search provider has a separate _derived_ gate: `available → reserved` when `SearchProviderCall(runId)` is inserted under a provider advisory lock; a full monthly budget yields a `paused` API result and no run (`src/import/service.ts`). A reserved call cannot be retried with the same run ID after a provider failure; the call is conservatively counted as attempted.

The DIP checkpoint is _unseen_ (`updatedThrough = null`) or _through T_. A successful window changes `T` to `max(T, window end or maximum observed update)` in the same transaction that completes the run; failure leaves `T` intact (`src/dip/collect.ts`, `src/dip/sync.ts`). Scans overlap six hours from the prior checkpoint. `DipGap` is a derived failed-window view; a completed covering window removes it from the view (`src/dip/repository.ts`).

## Durable jobs and attempts

`ProcessingJob.status` is `pending | claimed | retrying | succeeded | exhausted`. A unique dedupe key prevents duplicate handoff; `attempts` counts claims, and `maxAttempts` is the claim budget (`src/jobs/`). A `JobAttempt` row belongs to each committed claim. `claimedBy` plus `attempts` identifies the current owner.

| From                                 | Event                                        | To                  | Invariant                                                                    |
| ------------------------------------ | -------------------------------------------- | ------------------- | ---------------------------------------------------------------------------- |
| absent                               | Enqueue                                      | pending             | Unique dedupe key; the owning run exists.                                    |
| pending or ready retrying            | Atomic claim                                 | claimed             | Claim increments `attempts` and creates its attempt row in one transaction.  |
| claimed, lease expired, budget left  | Reclaim or restart requeue                   | claimed or retrying | Previous unfinished attempt becomes `abandoned` when the next claim is made. |
| claimed, lease expired, budget spent | Claim scan or restart recovery               | exhausted           | Final attempt is closed as exhausted; no extra claim is issued.              |
| claimed, current owner               | Complete                                     | succeeded           | Only matching worker and attempt can finish it.                              |
| claimed, current owner               | Fail before budget                           | retrying            | Error and next attempt time are stored with the attempt outcome.             |
| claimed, current owner               | Fail at budget                               | exhausted           | Error and final outcome are stored.                                          |
| exhausted                            | Operator retry or on-demand document request | pending             | Retry increases the total budget and clears claim fields.                    |

Completion or failure from an old owner is a no-op. Workers report `stale` (or omit a news drain count) and do not apply the old attempt's failure fallback. External fetches, uploads, and embedding calls can still have happened before a lease handoff; their stored results use idempotent keys or document-reference locks (`src/import/publication.ts`, `src/dip/documents.ts`, `src/dip/repository.ts`).

### Confirmed queue issues, grouped as one fix

**P1 — lease ownership and retry budget.** Before this change, `completeJob` and `failJob` updated only by job ID. Sequence: worker A claims attempt 1; its lease expires; B claims attempt 2; A completes or fails; A overwrites B's `claimed` state and may let the run settle while B is processing. The claim update and attempt insert were also separate commits, so a crash between them left a claimed job with no attempt log. Finally, a stale claim at `attempts == maxAttempts` could be reclaimed as attempt `maxAttempts + 1`. These paths are visible in the former `src/jobs/` claim/complete/fail flow and are reproduced by the forced lease handoff and final-budget cases in `test/jobs.integration.ts`. The shared queue now commits claim plus log together, checks owner and attempt on settlement, and exhausts expired final attempts. News, PDF, and embedding callers handle lost ownership.

## Candidate and relevance decisions

A candidate's _derived_ processing state is `invalid`, `valid-unresolved`, or `resolved` from `errors` and `publicationId` (`src/import/candidate.repository.ts`, `src/import/service.ts`). Parse-invalid candidates get no job; valid feed candidates get a resolve job; a successful resolution links the publication and discovery in one transaction. Exhausted resolution leaves a valid-looking candidate without a publication, counted invalid at run finalization.

Search candidates add `accepted | uncertain | rejected` in `RelevanceReview` (`src/import/relevance.repository.ts`).

| From                  | Event                    | To                    | Invariant                                                                                               |
| --------------------- | ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------- |
| absent                | Search intake assessment | accepted or uncertain | Only accepted valid candidates get a resolve job.                                                       |
| uncertain or rejected | Operator accepts         | accepted              | Resolve job is enqueued or an exhausted one retried.                                                    |
| accepted or uncertain | Operator rejects         | rejected              | Rejection is refused while an unresolved resolve job is open; an existing publication is not retracted. |
| any decision          | Later operator review    | accepted or rejected  | Decision row is updated with operator, reason, and time.                                                |

## Publication text and parliamentary versions

`Publication.contentAvailability` is `metadata_only | full_text` (`prisma/schema.prisma`). Resolution creates metadata-only publications; extraction adds a numbered text version and switches to full text. Unchanged text reuses the latest version; extraction failure records an error and retains the original URL (`src/extract/repository.ts`). The invariant is that `full_text` has a stored version and feed excerpts never become publication versions. `extractionError` is diagnostic and can coexist with an older full-text version.

Proceedings and steps have an implicit version machine: `absent → version 1 → version N+1` on changed content hashes, with unchanged observations updating the current record but not adding a version. `latestVersionNo` points to the newest retained snapshot; each new version enqueues an embedding job (`src/dip/versions.ts`). Parentless steps are valid and intentionally retained (`prisma/schema.prisma`, `src/dip/proceeding.ts`).

## Document references, variants, and embeddings

A step's current `DocumentReference` may have no PDF URL. Its history remains in step-version snapshots. Document work follows `reference only → queued → fetched variant → page text/chunks → embedding jobs → indexed`. A failed document or embedding job follows the shared retry machine and does not roll back DIP collection (`src/dip/jobs.ts`, `src/dip/documents.ts`, `src/dip/embedding.ts`).

| From                                   | Event                          | To                                    | Invariant                                                                        |
| -------------------------------------- | ------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------- |
| No cached variant                      | PDF bytes fetched and archived | Variant 1, latest                     | Bytes are content-addressed; pages and variant commit together.                  |
| Latest variant                         | Same byte hash                 | Same latest variant                   | No new variant or extraction.                                                    |
| Latest variant                         | New byte hash                  | New numbered latest variant           | Earlier variants remain; one reference's writes are serialized by advisory lock. |
| Historical variant                     | Earlier bytes recur            | Historical variant promoted to latest | Variant numbers are never reused.                                                |
| Pages without chunks                   | Chunk generation               | Chunks present                        | `(content, page, chunk)` is unique.                                              |
| Source version/chunk without embedding | Embedding job succeeds         | Indexed                               | Unique source/version/page/chunk/model/instruction identity.                     |

`isLatest` is the derived active variant marker used by search (`src/dip/repository.ts`, `src/dip/search.ts`). A document request raises a pending job's priority or deliberately retries an exhausted one; a changed URL/date uses a new dedupe key (`src/dip/jobs.ts`, `src/dip/documents.ts`). Excerpt eligibility is a separate derived `metadata-only | excerpt-eligible` classification and does not alter storage (`src/dip/excerpts.ts`).

## Verification

`pnpm check` and `pnpm test` pass (88 passed, one existing hosted smoke test skipped). The two new database regression tests could not execute here because the configured Neon host failed DNS resolution (`ENOTFOUND`); they are ready for a database-connected run.
