# Issue #33 QA plan — lazy DIP PDF processing for retrieval

Goal: prove the end-to-end loop for this ticket — DIP collection stores
document references and queues PDF work without fetching bytes, a durable
document job downloads/extracts/caches a variant and hands embedding to its
own job, an on-demand request returns metadata immediately and jumps the
queue, and retrieval returns page-level `dokument` hits from the latest
variant. See the [table reference](database-tables.md) and [processing
jobs](processing-jobs.md) for the record and job semantics.

Starting point: `scripts/reset-db.sh` has already been run, so the database
is migrated from scratch and holds only the seeded news fixture run (`seed`).
DIP tables are empty. No HTTP trigger exists for fixture-driven DIP
collection, so collection/document cases drive the service layer with short
`node` scripts against `dist/` (built by `pnpm build:test`); the on-demand,
drain and search endpoints are exercised with `curl`. Every case except
QA-9 and QA-11 is offline and deterministic.

## Prerequisites

```sh
pnpm install --frozen-lockfile
docker compose up -d --wait
pnpm build:test && pnpm build
# PyMuPDF is required by the child-process extractor and is NOT on the
# Homebrew system python3 (PEP 668 externally-managed). Use a venv and put
# its `python3` on PATH so the app's extractor resolves it.
python3 -m venv .venv                 # once, if .venv is missing
.venv/bin/pip install pymupdf         # once
.venv/bin/python -c "import pymupdf"  # must print the version
PATH="$PWD/.venv/bin:$PATH" pnpm start   # serves http://127.0.0.1:3000
```

Do not run `python3 -m pip install pymupdf`: the Homebrew interpreter rejects
system-wide installs (`externally-managed-environment`). Every `node` script in
this plan inherits the exported `PATH`, so document extraction works without
further setup.

Use fresh run IDs per case (suggestions below). Names below assume the fixture
step helper shape: `id`, `typ: "Vorgangsposition"`, `vorgangsposition`,
`zuordnung`, `gang/fortsetzung/nachtrag`, `vorgangstyp`, `titel`,
`dokumentart`, `vorgang_id`, `datum`, `aktualisiert`, `fundstelle`
(`id`, `dokumentnummer`, `datum`, `pdf_url`), `aktivitaet_anzahl`.

## Cases

### QA-1 — Automated suite still passes

```sh
pnpm check && pnpm test && pnpm format
pnpm build:test
node --env-file-if-exists=.env --test \
  dist/test/dip-documents.integration.js \
  dist/test/dip-search.integration.js \
  dist/test/dip-jobs.integration.js \
  dist/test/sync.integration.js
```

Expected: type check clean, all unit tests pass (including `pdf.test.ts`,
which injects a fake extractor so no Python is needed), the four DIP
integrations pass in self-created isolated schemas, formatting clean. The
real-embedding search test is skipped unless `OLLAMA_QA=1`.

### QA-2 — Fresh schema and empty DIP state

```sh
docker compose exec -T db psql -U news -d news -c "
  SELECT COUNT(*) FROM document_contents;
  SELECT COUNT(*) FROM document_pages;
  SELECT COUNT(*) FROM document_references;
  SELECT COUNT(*) FROM processing_jobs WHERE operation IN
    ('process_document','embed_document');
  SELECT enum_range(NULL::\"ParliamentaryEntity\");"
```

Expected: `document_contents`, `document_pages`, `document_references` all 0
(no DIP collection has run); no `process_document`/`embed_document` jobs; the
`ParliamentaryEntity` enum contains `vorgang`, `vorgangsposition`,
`dokument`; `processing_jobs.priority` exists (migration `20261018120000`
applied). The seeded news `seed` run is present and unchanged.

### QA-3 — Collection stores references and queues PDF work without fetching bytes

Deterministic: pass an explicit `now` so the hot window never depends on the
clock. `2026-10-10` makes the fixture's `2026-10-08/09` references hot.

```sh
node --env-file-if-exists=.env --input-type=module -e "
const { database } = await import('./dist/src/db.js');
const { collectSteps } = await import('./dist/src/dip/steps.js');
const prisma = database();
const fundstelle = (id, datum, pdfUrl) => ({
  id, dokumentnummer: '21/1001', datum,
  ...(pdfUrl ? { pdf_url: pdfUrl } : {}),
});
const step = (id, refId, datum, pdfUrl, share) => ({
  id, typ: 'Vorgangsposition', vorgangsposition: 'Kleine Anfrage',
  zuordnung: 'BT', gang: false, fortsetzung: false, nachtrag: false,
  vorgangstyp: 'Kleine Anfrage', titel: 'Titel ' + id,
  dokumentart: 'Drucksache', vorgang_id: '340135', datum,
  aktualisiert: datum + 'T13:24:22+02:00',
  fundstelle: fundstelle(refId, datum, pdfUrl), aktivitaet_anzahl: 0,
  ...share,
});
const docs = [
  step('701400', '291500', '2026-10-09', 'https://dserver.bundestag.de/btd/21/010/2110010.pdf'),
  step('701401', '291500', '2026-10-09', 'https://dserver.bundestag.de/btd/21/010/2110010.pdf'),
  step('701402', '290999', '2026-10-09', null),
  step('701403', '291000', '2026-10-09', 'https://dserver.bundestag.de/brd/2026/0583-26.pdf'),
];
const run = await collectSteps(prisma, {
  runId: 'qa-doc-collect-1', electoralTerm: 21,
  now: new Date('2026-10-10T00:00:00Z'),
  fetchPage: async () => ({ documents: docs, cursor: '', numFound: docs.length }),
});
console.log('run', JSON.stringify(run));
console.log('refs', await prisma.documentReference.count());
console.log('docJobs', await prisma.processingJob.count({ where: { operation: 'process_document' } }));
console.log('contents', await prisma.documentContent.count());
await prisma.\$disconnect();
"
```

Expected: `run.valid: 4`, `replayed: false`; `refs: 4` (every step retains
`reference_id`, `document_number`, nullable `pdf_url`, `document_date`);
`docJobs: 3` — the two steps citing `291500` share one job, `290999` queues
one despite having no `pdf_url`, `291000` queues one, and the run returns
without any network PDF fetch; `contents: 0`. The `dip_checkpoint` for
`/vorgangsposition`/21 advanced even though document work is pending.

### QA-4 — Document job downloads, caches, extracts pages and hands off embedding

Uses stubs so it is offline; the real extractor is QA-6/QA-11.

```sh
node --env-file-if-exists=.env --input-type=module -e "
const { database } = await import('./dist/src/db.js');
const { processNextDocument } = await import('./dist/src/dip/documents.js');
const prisma = database();
const pages = [
  { page: 1, text: 'Deutscher Bundestag Drucksache 21/1001' },
  { page: 2, text: 'Anlage 1 Haushalt' },
];
const job = await prisma.processingJob.findFirstOrThrow({
  where: { operation: 'process_document', payload: { path: ['referenceId'], equals: '291500' } },
});
const result = await processNextDocument(prisma, 'qa-worker', {
  jobId: job.id,
  fetchPdf: async () => ({ ok: true, bytes: Buffer.from('%PDF-1.7 qa'), finalUrl: 'https://dserver.bundestag.de/btd/21/010/2110010.pdf' }),
  extract: async () => pages,
});
console.log('result', JSON.stringify(result));
const content = await prisma.documentContent.findFirstOrThrow();
console.log('content', JSON.stringify({ variantNo: content.variantNo, pageCount: content.pageCount, isLatest: content.isLatest, byteSize: content.byteSize }));
console.log('pages', JSON.stringify(await prisma.documentPage.findMany({ where: { contentId: content.id }, orderBy: { pageNo: 'asc' }, select: { pageNo: true, text: true } })));
console.log('embedJobs', await prisma.processingJob.count({ where: { operation: 'embed_document', status: 'pending' } }));
await prisma.\$disconnect();
"
```

Expected: `result.status: "succeeded"`, `variantNo: 1`, `reused: false`;
one `document_contents` row (`page_count: 2`, `is_latest: true`) and two
`document_pages` with pages 1–2; one pending `embed_document` job per page
(two here); the `process_document` job is `succeeded`. Longer-than-`maxBuffer` or a
failed extraction path is covered by `pdf.test.ts`.

### QA-5 — Cache identity: identical bytes reuse, changed bytes add a variant

```sh
node --env-file-if-exists=.env --input-type=module -e "
const { database } = await import('./dist/src/db.js');
const { collectSteps } = await import('./dist/src/dip/steps.js');
const { processNextDocument } = await import('./dist/src/dip/documents.js');
const prisma = database();
const step = (datum, pdfUrl) => ({
  id: '701410', typ: 'Vorgangsposition', vorgangsposition: 'Kleine Anfrage',
  zuordnung: 'BT', gang: false, fortsetzung: false, nachtrag: false,
  vorgangstyp: 'Kleine Anfrage', titel: 'T', dokumentart: 'Drucksache',
  vorgang_id: '340135', datum, aktualisiert: datum + 'T00:00:00+02:00',
  fundstelle: { id: '292000', dokumentnummer: '21/2000', datum, pdf_url: pdfUrl },
  aktivitaet_anzahl: 0,
});
const pages = [{ page: 1, text: 'Fassung' }];
const collect = (runId, pdfUrl) => collectSteps(prisma, {
  runId, electoralTerm: 21, now: new Date('2026-10-10T00:00:00Z'),
  fetchPage: async () => ({ documents: [step('2026-10-09', pdfUrl)], cursor: '', numFound: 1 }),
});
const jobFor = () => prisma.processingJob.findFirstOrThrow({
  where: { operation: 'process_document', payload: { path: ['referenceId'], equals: '292000' } },
  orderBy: { createdAt: 'desc' },
});
let bytes = Buffer.from('%PDF identical');
const fetchPdf = async () => ({ ok: true, bytes, finalUrl: 'https://dserver.bundestag.de/x.pdf' });
const run = async (label) => console.log(label, JSON.stringify(
  await processNextDocument(prisma, 'w', { jobId: (await jobFor()).id, fetchPdf, extract: async () => pages })));
await collect('qa-doc-cache-1', 'https://dserver.bundestag.de/a.pdf');
await run('first');
await collect('qa-doc-cache-2', 'https://dserver.bundestag.de/b.pdf');
await run('reused');            // changed URL -> new job, identical bytes -> same variant
bytes = Buffer.from('%PDF changed');
await collect('qa-doc-cache-3', 'https://dserver.bundestag.de/c.pdf');
await run('changed');           // new bytes -> new retained variant
console.log('variants', JSON.stringify(await prisma.documentContent.findMany({ orderBy: { variantNo: 'asc' }, select: { variantNo: true, isLatest: true } })));
console.log('contents', await prisma.documentContent.count());
console.log('embedJobs', await prisma.processingJob.count({ where: { operation: 'embed_document', payload: { path: ['referenceId'], equals: '292000' } } }));
await prisma.\$disconnect();
"
```

Expected: `first` succeeds as `variantNo: 1, reused: false`; `reused` (new
reference revision, identical bytes) reports `variantNo: 1, reused: true` and
leaves `contents: 1`; `changed` reports `variantNo: 2, reused: false`. Final
`variants` is `[{1,false},{2,true}]` and `embedJobs` is 2 (one per variant
page — the reused variant adds no duplicate job). The concurrent-variant race is
pinned by `dip-documents.integration.ts` (unique `reference_id, variant_no`
turns the loser into a retry); do not try to reproduce it by timing two
processes manually.

### QA-6 — Real PyMuPDF extraction through the child process

```sh
export PATH="$PWD/.venv/bin:$PATH"   # pymupdf lives in the repo venv, not Homebrew's python3
python3 -c "import pymupdf; d=pymupdf.open(); p=d.new_page(); p.insert_text((72,72),'Deutscher Bundestag 21/1001 Haushalt'); d.save('/tmp/qa-doc.pdf')"
node --input-type=module -e "
import { readFile } from 'node:fs/promises';
const { pymupdfExtractor } = await import('./dist/src/dip/pdf.js');
console.log(JSON.stringify(await pymupdfExtractor(await readFile('/tmp/qa-doc.pdf'))));
"
```

Expected: one page whose text includes `Deutscher Bundestag 21/1001
Haushalt`. The `export` is per-shell: any new terminal running an extractor
case needs it again (only cases QA-6, QA-8's `291000` fetch, QA-9 and QA-11
touch PyMuPDF). If `python3` lacks PyMuPDF the promise rejects with
`PDF extraction failed: pymupdf is not installed; run ...` — that message is
the first thing to check when a document job fails.

### QA-7 — On-demand request returns metadata, raises priority, is idempotent

Depends on QA-3's references.

```sh
curl -s http://127.0.0.1:3000/api/documents/290999
curl -s http://127.0.0.1:3000/api/documents/290999
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/documents/abc
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/documents/999999
docker compose exec -T db psql -U news -d news -c "SELECT COUNT(*) FROM processing_jobs WHERE operation='process_document';"
```

Expected: both calls return `processed:false`, the full `reference`
(`referenceId: "290999"`, `stepApiId`, `proceedingApiId`, `documentNumber`,
`documentDate`, `pdfUrl: null`) and `job.status: "pending"` with
`job.priority: 10`; the count stays one job for `290999` (the request raises
the existing background job, never adds one). Non-numeric id → HTTP 400
(`Document reference ID must be numeric`); unknown numeric id → HTTP 404
(`Document reference not found`).

### QA-8 — Drain endpoints process exactly one job per call

```sh
curl -s -X POST http://127.0.0.1:3000/api/drain-documents   # 290999 first (priority 10)
curl -s -X POST http://127.0.0.1:3000/api/drain-documents   # 291000 (priority 0)
curl -s -X POST http://127.0.0.1:3000/api/drain-documents   # empty
docker compose exec -T db psql -U news -d news -c "
  SELECT payload->>'referenceId' AS ref, status, priority, attempts, last_error
  FROM processing_jobs WHERE operation='process_document' ORDER BY created_at;"
```

Expected: the first call claims `290999` despite the older `291000` job still
waiting, proving the on-demand priority raise, and returns
`{status:"retrying"}` with `last_error` = `Document reference has no
pdf_url`; `document_contents` stays empty for `290999`. The second call
processes `291000` through the real fetcher — `{status:"succeeded"}` if the
recorded URL resolves, otherwise `{status:"retrying"}` with an HTTP/size/
format reason; either way exactly one job is attempted per call. The third
returns `{status:"empty"}`. `POST /api/drain-dip` returns `{status:"empty"}`
until Ollama is reachable and pending embedding jobs exist. The final query
shows `291500` and `291000` succeeded when the live fetch worked, `290999`
retrying with `attempts` incremented.

### QA-9 — Live end-to-end PDF fetch and retrieval (opt-in, network + Ollama)

Requires `BUNDESTAG_API_KEY` in `.env` and network. Store real references with
a live DIP collection. `proceedingCap` is optional and bounds how many
proceedings are stored; it defaults to `LOCAL_PROCEEDING_CAP` (1000). It also
bounds the import work: a capped baseline scan stops paging once the cap is
reached, and fetches steps only for the stored proceedings rather than
paginating the whole term. A small value keeps the import short:

```sh
curl -s -X POST http://127.0.0.1:3000/api/collect-dip \
  -H 'Content-Type: application/json' \
  -d '{"runId":"qa-live-dip-1","electoralTerm":21,"source":"live","proceedingCap":25}'
```

Expected: `{"attribution":"Source: Deutscher Bundestag (DIP)","outcome":{
"completed":[{"endpoint":"/vorgang",...},{"endpoint":"/vorgangsposition",...}],
"failed":[]}}` — one run per endpoint/term (`qa-live-dip-1:<endpoint>:21`),
with the `/vorgang` result showing `capped > 0` once the cap is reached. A
non-integer or `< 1` `proceedingCap` is rejected with HTTP 400. `failed` must
be empty: the single-item `/vorgang/{id}` endpoint behind parent backfill is
bot-challenged (a 303 to an Enodia page that returns 400), and the collector
now skips such parents instead of failing the whole `/vorgangsposition` run.
A run's input hash includes `proceedingCap`, so retry a failed run with the
**identical** request (same `runId`); changing any field, including the cap,
requires a fresh `runId` (`Run ID already belongs to a different input`).
Only completed runs replay. Steps dated within the last 14 days queue
`process_document` jobs automatically; pick a real reference id from a hot
step:

```sh
docker compose exec -T db psql -U news -d news -c "
  SELECT step_id, reference_id, document_number, pdf_url, document_date
  FROM document_references
  WHERE pdf_url IS NOT NULL AND document_date > now()::date - 14
  ORDER BY document_date DESC LIMIT 5;"
```

Then confirm an embedding model is reachable:

```sh
curl -s http://127.0.0.1:11434/api/tags   # must list qwen3-embedding:0.6b
```

- If you already run Ollama locally on 11434 (common), that is the default the
  app uses — do **nothing**; `docker compose --profile embeddings up -d` will
  fail with `address already in use` and is not needed. Pull the model once if
  missing: `ollama pull qwen3-embedding:0.6b`.
- Otherwise start the Compose profile. If 11434 is taken, set
  `OLLAMA_PORT=11435` in `.env` and restart Compose **and** `pnpm start` so the
  app reads the same port.

```sh
ref=29701499   # replace with a referenceId from the query above
curl -s http://127.0.0.1:3000/api/documents/$ref            # raises priority
curl -s -X POST http://127.0.0.1:3000/api/drain-documents   # real fetch + PyMuPDF
curl -s -X POST http://127.0.0.1:3000/api/drain-dip         # embeddings (repeat until empty)
curl -s -X POST http://127.0.0.1:3000/api/search-dip -H 'Content-Type: application/json' \
  -d '{"query":"Haushalt","limit":10}'
```

Expected: the document job succeeds and stores real page text; `drain-dip`
succeeds per page; `search-dip` returns `dokument` results whose `page`,
`document.referenceId`/`number`/`pdfUrl` and `source.url` point at the
original PDF, and only the latest variant is returned (no duplicate hit from
variant 1). With Ollama stopped, document fetch/extract still succeeds and
only `drain-dip` fails — search and stored records remain available.

### QA-10 — Document work never blocks collection or moves the checkpoint

```sh
docker compose exec -T db psql -U news -d news -c "
  SELECT endpoint, electoral_term, updated_through FROM dip_checkpoints;
  SELECT status, COUNT(*) FROM processing_jobs GROUP BY status;"
```

Expected: after QA-3, `/vorgangsposition`/21 has a checkpoint; the pending
`process_document`/`embed_*` jobs do not stop the run from completing, and
replaying any QA-3 run returns the stored result without adding jobs
(`replayed: true`). Running QA-3 again with a fresh run ID and unchanged
step content adds no document jobs (`refChanged` is false).

### QA-11 — Failure, restart and revival behavior

Deterministic checks; the exhaustive retry/restart loop is pinned by
`dip-documents.integration.ts` and `dip-jobs.integration.ts`.

```sh
docker compose exec -T db psql -U news -d news -c "
  SELECT operation, status, attempts, max_attempts, priority, last_error
  FROM processing_jobs WHERE operation='process_document' ORDER BY created_at;"
```

Expected: the `290999` job is `retrying` with `attempts` incremented and a
`last_error`; on-demand `GET /api/documents/<id>` sets its `priority` to 10
and `next_attempt_at` to now. Force an exhausted job by draining a reference
with a non-PDF/oversized URL until `attempts = max_attempts` (between drains,
set `next_attempt_at = now()` in psql to skip the 30s–1h backoff), then
confirm `GET` revives it to `pending` with `max_attempts` doubled and
`last_error` cleared. A worker that dies mid-claim is reclaimable once its
5-minute lease
expires; `POST /api/drain` (which calls `requeueStaleClaims`) requeues stale
claims at epoch time, so recovery does not depend on clock agreement.

### QA-12 — Admin DIP page reflects document jobs

Open http://127.0.0.1:3000/admin/dip.

Expected: "Jobs needing attention" lists retrying (the `290999` job from
QA-8) and exhausted rows with their last errors; the hint counts pending
embedding/document work. After QA-9 drains everything, the counts drop to 0.
Retry on an exhausted row resets its budget and reprocesses the run.

## Result log

| Case                                    | Result (pass/fail) | Notes / actual values           |
| --------------------------------------- | ------------------ | ------------------------------- |
| QA-1 automated suite                    |                    |                                 |
| QA-2 fresh schema / empty DIP state     |                    |                                 |
| QA-3 collection queues without fetching |                    |                                 |
| QA-4 document job cache/extract/handoff |                    |                                 |
| QA-5 cache identity and variants        |                    |                                 |
| QA-6 real PyMuPDF extraction            |                    |                                 |
| QA-7 on-demand metadata/priority        |                    |                                 |
| QA-8 drain endpoints one-per-call       |                    |                                 |
| QA-9 live fetch + retrieval (opt-in)    |                    | skipped without Ollama/network? |
| QA-10 collection unblocked              |                    |                                 |
| QA-11 failure/restart/revival           |                    |                                 |
| QA-12 admin DIP jobs view               |                    |                                 |

## Out of scope

News-to-proceeding linking, live DIP scheduling and backfill windows
(issue #8/#15), PDF retention/reuse permission of the DIP API contract (the
data is kept locally only), multi-term/historical electoral transitions, and
a database-crash or host-reboot recovery test. This plan exercises
application-process restarts only.
