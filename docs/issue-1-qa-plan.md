# Issue #1 QA plan — import a feed URL, verify the database, review in admin

Goal: prove the end-to-end loop for this ticket — take an RSS feed URL, import
it, confirm the records in PostgreSQL, and review them on the local admin page.
See the [table reference](database-tables.md) for what each record means and
[issue-1-verification](issue-1-verification.md) for the automated evidence.

## Prerequisites

```sh
pnpm install --frozen-lockfile
cp .env.example .env   # once; DATABASE_URL points at local Compose PostgreSQL
docker compose up -d --wait
pnpm build
```

Use fresh run IDs per case (suggestions below). Live-feed entry counts change
over time, so live expectations are structural (`completed`, rows present), not
exact counts. The fixture is deterministic: 2 valid, 1 invalid.

## Cases

### QA-1 — Import the deterministic fixture

```sh
pnpm collect-fixture qa-f001
```

Expected: JSON result `status: "completed"`, `validCount: 2`, `invalidCount: 1`,
`feedId: "bundestag-aktuelle-themen-fixture"`, exit code 0.

### QA-2 — Confirm the fixture in the database

```sh
pnpm studio
```

Expected: in `runs`, one row `qa-f001` (`completed`, 2/1). In `publications`,
two rows (German `Öffentliche Anhörung: Wohnen & Städte`, English
`Committee discusses healthcare access`). In `candidates`, three rows for
`qa-f001`, one with two errors. In `discoveries`, two rows for `qa-f001`. No
`description` or article text in any `metadata` JSON.

### QA-3 — Review the fixture in the admin page

```sh
pnpm start   # open http://127.0.0.1:3000/?run=qa-f001#candidates
```

Expected: run `qa-f001` listed with 2 valid / 1 invalid; candidates section
shows both headlines accepted and the third rejected with `Missing headline` /
URL errors; publications show publisher, original URL, dates, `Metadata only`.

### QA-4 — Import the configured live feed

```sh
pnpm verify
pnpm collect qa-live-001
```

Expected: `verify` prints the Deutschlandfunk Nachrichten summary without
writing rows. `collect` returns `completed` with `validCount` equal to the entry
count and `invalidCount: 0`. A new `runs` row and one `publications` row per
entry appear; the admin publications section lists Deutschlandfunk headlines
with dates and original URLs.

### QA-5 — Import an arbitrary RSS feed URL

```sh
pnpm collect qa-custom-001 https://www.deutschlandfunk.de/politikportal-100.rss
```

Expected: `completed`; `feedId` starts with `custom-` and contains the host
(e.g. `custom-www.deutschlandfunk.de-<hash>`); the run's publications carry
publisher `www.deutschlandfunk.de`; the admin run selector shows
`qa-custom-001` with its own candidates and discoveries, separate from the QA-4
run.

### QA-6 — Replay is idempotent

```sh
pnpm collect-fixture qa-f001
```

Expected: identical JSON to QA-1 (same `completedAt`, same counts). Record
counts in `runs`, `publications`, `candidates`, `discoveries` are unchanged
before and after (compare in Studio or restart the admin and compare pages).

### QA-7 — Changed input under a reused run ID is rejected

```sh
pnpm collect qa-f001   # reuses the QA-1 ID against a different feed/input
```

Expected: error `Run ID already belongs to a different input; use a new run
ID`, exit code 1, no new or altered rows. (Same-feed snapshots that changed
since collection behave the same way: a fresh run ID is required per snapshot.)

### QA-8 — A non-RSS URL records a failed run

```sh
pnpm collect qa-bad-001 https://example.org/
```

Expected: JSON result `status: "failed"` with a parse `error`, exit code 1. The
`runs` row exists with `validCount: 0`, `invalidCount: 0`. No partial
publications or candidates are stored for it.

### QA-9 — Data survives restarts

1. Stop the admin (Ctrl-C), run `pnpm start` again: the page is identical.
2. `docker compose down` then `docker compose up -d --wait`, then `pnpm start`:
   all runs and publications are still listed (persistent Compose volume).

Expected: no data loss in either restart; replaying no run is required.

### QA-10 — Automated suite still passes

```sh
pnpm check && pnpm test && pnpm test:integration && pnpm format
```

Expected: type check clean, all unit tests pass, the integration test passes in
its isolated schema (it creates and drops the schema itself), formatting clean.

## Result log

| Case                         | Result (pass/fail) | Notes / actual values |
| ---------------------------- | ------------------ | --------------------- |
| QA-1 fixture import          |                    |                       |
| QA-2 fixture in DB           |                    |                       |
| QA-3 fixture in admin        |                    |                       |
| QA-4 live feed import        |                    |                       |
| QA-5 arbitrary URL import    |                    |                       |
| QA-6 idempotent replay       |                    |                       |
| QA-7 changed-input rejection |                    |                       |
| QA-8 failed run              |                    |                       |
| QA-9 restarts                |                    |                       |
| QA-10 automated suite        |                    |                       |

## Out of scope

Full-text extraction (blocked on feed terms), scheduling, historical
completeness, relevance review, multi-feed orchestration, deployment, and
database-crash recovery are later tickets. This plan covers application-process
restarts only, not a database crash or host reboot.
