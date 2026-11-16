## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `rotimi-babalola/news-intelligenz`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout at the repo root. See `docs/agents/domain.md`.

### `docs` layout

`docs` is organised by purpose. Do not add markdown files at its root; put a file in the folder that owns the subject, and keep relative links working when a file moves.

- `adr/` — numbered architecture decisions, one file per decision.
- `agents/` — agent instructions referenced from `AGENTS.md`.
- `architecture/` — current target architecture and the design interviews behind it.
- `reference/` — database tables, processing jobs, and state machines.
- `evaluation/` — retrieval and answer evaluation guides, their dated runs and label JSON, and investigation reports.
- `verification/` — issue QA plans and verification reports.
- `research/` — historical source research that does not define current scope.

### `src/dip` module layout

`src/dip` is organised by concern. Do not add new flat files at its root; put a file in the existing folder that owns the behaviour.

- `collection/` — DIP `/vorgang` and `/vorgangsposition` collection, checkpoints, source versions, schedules, and raw payload parsing.
- `documents/` — PDF fetch/extraction, chunks, sections, excerpts, citation currency and status, object storage, processing, and section verification.
- `search/` — embedding provider, vector search, dossier assembly, and relevance evaluation.
- `proceedings/` — proceeding timeline read model.
- `jobs/` — DIP job operations, embedding worker, and reindex.
- `db/` — every Prisma read and write, split by entity; import through `db/index`.
- `explain/` — brief generation, provider calls, evidence collection, citation/claim validation, answer assembly, and answer evaluation.
- `constants.ts` — shared tunables, endpoints, job names, and limits; look here before adding a new literal.

Each file owns one concern. Split a file when it grows a second responsibility instead of adding a shared `util`. A folder's `index.ts` is only its public entry point, never a place for new logic.

### `src/jobs` module layout

`src/jobs` is the shared job queue, organised by concern. Do not add new flat files at its root; put a file in the existing folder that owns the behaviour, and import through `jobs/index`.

- `refs.ts` — source kinds and the `feedSource`, `searchSource` and `dipSource` constructors.
- `policy.ts` — attempt and lease limits, backoff, `Retry-After` parsing, and `RateLimitedError`.
- `enqueue.ts` — job identity (`dedupeKey`) and `enqueueJob`.
- `claim.ts` — the atomic claim, `ClaimedJob`, claim filters, and expired-claim exhaustion.
- `settle.ts` — `completeJob` and `failJob`, including retry, backoff and error capture.
- `recovery.ts` — restart recovery (`requeueStaleClaims`) and deliberate `retryExhausted`.
- `runner.ts` — the claimed-job loop, `JobOutcome`, and `runJobs`/`runNextJob`.
- `queries.ts` — job listings and counts.

Every worker goes through the runner: it supplies a filter and a handler, and never calls `completeJob` or `failJob` itself.

### Parliamentary research

For questions about DIP proceedings, steps, or documents, check for the `news-intelligenz` MCP server and use its `get_proceeding`, `search_dip_evidence`, or `get_document_pages` tool first, as appropriate. See the MCP setup in `README.md`. If the server is unavailable, the record is missing, or fresh information is needed, consult official DIP sources and say explicitly why the MCP server could not answer.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
