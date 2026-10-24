# DIP collection design interview

Status: DIP collection, multilingual retrieval, and lazy PDF processing decisions confirmed and implemented. [ADR 0007](adr/0007-dip-only-parliamentary-collection.md) later made DIP the sole target source; news references below describe the earlier phase.

## Settled decisions

- Replace Bundestag RSS collection with DIP API collection. The earlier choice to keep public-news RSS was superseded by ADR 0007; the target now collects DIP only.
- Use `/vorgang` as the entry point for parliamentary proceedings and their summaries and deliberation status. Collect individual proceeding steps through `/vorgangsposition` as evidence of developments.
- Include all proceeding types in the current electoral term, rather than restricting collection to legislation.
- Treat proceedings and proceeding steps as distinct domain concepts; a proceeding is not itself an article or institutional document.
- Initially import the full current electoral term and its proceeding steps in nonlocal environments; local environments apply the 1,000-proceeding cap below. Then collect incremental updates. This imports the states available at collection time; it cannot reconstruct earlier unobserved revisions.
- Retain structured API metadata, available summaries, proceeding steps, and document references. Embed a proceeding title even when its optional summary is absent; records with no searchable text remain metadata-only.
- On `/vorgang`, locally import at most 1,000 unique proceedings across runs: keep the first 1,000 encountered through cursor pagination, continue syncing those records, and import their associated steps. The API contract does not specify result ordering, so the local subset is not guaranteed to be the most recent. Other environments import the full selected scope.
- Collect document references eagerly from `/vorgangsposition`. Retain each step's `vorgang_id` and available `fundstelle` fields (`id`, `dokumentnummer`, `pdf_url`, `datum`) and link the reference to the parent proceeding. Do not fetch PDF bytes during DIP collection or before advancing its checkpoint.
- Embed each proceeding's title and available summary, and each step's available descriptive text, with local Qwen3-Embedding-0.6B served by optional Ollama in Compose. Persist vectors and model, task-instruction, source-record, and source-version metadata in PostgreSQL with pgvector. Use durable retryable jobs so model outages do not prevent DIP records from being stored.
- Re-embed changed text versions. Retain historical embeddings, but include only the latest version of each proceeding and step in retrieval. Use compatible, fixed document and query instructions.
- Provide a retrieval API for German and English queries against one multilingual index. Return matching proceedings, steps, and processed PDF text with source references; do not generate answers or add a reader-facing chat interface in this increment.
- Fetch and process PDF bytes in independent, low-priority document jobs for references whose `fundstelle.datum` is within the previous 14 days. The on-demand document API returns metadata and the original `pdf_url` immediately and raises processing priority when an unprocessed document is requested. PDF jobs do not block DIP import checkpoints.
- Extract PDF text with PyMuPDF and embed searchable text while retaining its document reference and page provenance. Keep fetched document bytes as content-addressed cache entries keyed by `fundstelle.id` and byte hash; retain each fetched variant indefinitely, subject to source permissions. A changed byte hash represents a distinct content variant. Cache reuse does not establish permission to retain or republish source content.
- Select PDFs from DIP document dates or on-demand requests, without news overlap.
- Preserve changed states of proceedings and steps. An API record update is a data change, not by itself evidence of a new parliamentary event; documented proceeding steps provide evidence of developments.
- In nonlocal environments, collect all proceedings returned for selected electoral terms and retain all their steps, labeled by institution. Coverage includes Bundestag, Bundesrat, Bundesversammlung, and Europakammer activity; call the source parliamentary activity. In local environments, import steps for the capped set of proceedings.
- Keep daily collection at 07:00 Europe/Berlin with six hours of overlap. Track proceedings and steps independently by update timestamp. Advance each checkpoint only after all pages are durably stored.
- Add new electoral terms explicitly and continue checking previously included terms for updates. Do not automatically import every historical term.
- Provide an internal proceeding list and detail view with summary, status, steps, document references, retained versions, collection progress, and failures. Historical articles remain in legacy inspection paths until cleanup.

## API evidence

Source: user-supplied DIP OpenAPI specification, version 1.5 (`/Users/rotimibabalola/Downloads/openapi.yaml`).

- `Vorgang.aktualisiert` is the entity's last update timestamp; it does not identify the reason for the update.
- `Vorgang.datum` dates its latest associated document. Date filters for proceedings use the date range of associated documents.
- Both collection endpoints support update-time filters and cursor pagination. Subsequent pages repeat the original parameters and pass the returned cursor; pagination ends when the cursor stops changing.
- Proceeding steps reference their parent through `vorgang_id`.
- Both endpoints support electoral-term filters, but step payloads do not contain an electoral-term field. Verify how step filtering relates to parent proceedings and cross-term documents; retain unresolved parent references for inspection rather than discarding steps.
- IDs are numeric strings; preserve them as strings. Summaries and proceeding status are optional. A step's displayed activity list is limited to four entries and must not be described as complete person/activity coverage.
- In OpenAPI v1.5, `Vorgang` has an `id` but no `vorgang_id` or `fundstelle` property. `Vorgangsposition` has required `vorgang_id` and required `fundstelle`; `Fundstelle` defines `id`, `dokumentnummer`, `pdf_url`, and `datum` (with other optional document metadata). Document references therefore belong to the step that supplies them and connect to the proceeding through `vorgang_id`; do not model them as fields directly returned by `/vorgang`.
- The `/vorgang` cursor parameter supports continuation while the cursor changes, but the supplied specification does not define a result sort order. The local 1,000-record cap is a cap on the first cursor-traversed records, not a recency guarantee.

## Implementation details and verification

- Identify DIP records by source, entity type, and API ID; retain the parent relationship from each step to its proceeding. Do not apply article URL or title matching to these identities.
- Retain endpoint, selected scope, query window, run, and observation time as provenance. Replaying a run must not duplicate discoveries or retained versions; a new run may record another encounter without adding an unchanged version.
- Bound each incremental scan by a fixed update-time window and paginate with unchanged query parameters. Keep durable progress per endpoint and selected scope; never substitute document dates for update timestamps.
- Independently discover changed steps; do not assume every step change updates its parent proceeding's timestamp. Fetch missing parent or step context as needed without claiming that independently fetched endpoints form an atomic snapshot.
- Initial import establishes a baseline of currently available records. Verify the bootstrap-to-incremental handoff and interrupted pagination without claiming recovery of past unobserved revisions.
- Validate authentication, current usage terms, rate limits, filters, timestamp boundaries, and live response behavior before enabling collection. The supplied specification describes the API contract; it does not establish retention permission or snapshot consistency.
- Use explicit timezone offsets for API windows and verify indexing delay and cursor expiry. The six-hour overlap is a recovery policy, not a guarantee that every delayed update is captured. Validate retrieval of the selected proceedings' steps rather than assuming an endpoint term filter guarantees complete lifecycle coverage.
- Missing records in an incremental response do not prove deletion. Verify deletion semantics before implementing removal or any claim of a fully reconciled mirror.
- Keep the existing PostgreSQL storage, durable jobs, bounded retries, and single-operator admin architecture. Database layout and client implementation remain implementation details.
- Use independent processing paths after DIP intake: proceeding/step embedding jobs and PDF fetch/extraction/embedding jobs. Neither path may hold the `/vorgang` or `/vorgangsposition` collection checkpoint open.
- Use `fundstelle.datum` for the 14-day PDF hot set. Keep it distinct from `aktualisiert`, which remains the source update timestamp for synchronization. PDF retrieval may also be queued at high priority on demand.
- Only the latest proceeding/step text versions are searchable. Historical record versions remain retained; historical embeddings may be retained but do not create duplicate retrieval hits.
- Return source references for retrieval results, including proceeding/step identity and, for PDF-derived text, document identity and page. A result is supporting source material, not a generated answer.
- Verify local imports stop at 1,000 unique `/vorgang` records across runs while continuing to update those records; verify a nonlocal configuration can import the entire selected scope. Verify local step collection follows the selected parent set.
- Verify PDF metadata/reference persistence without fetching during collection, independent document-job retries, 14-day selection by `fundstelle.datum`, high-priority on-demand requests, cache idempotence by document ID and byte hash, extraction/page provenance, and no premature DIP checkpoint advancement.
- Verify that German and English queries can retrieve the same German source records, latest-version filtering excludes historical duplicates, and model outages leave source records intact while embedding jobs remain retryable.

## Verification criteria

- Complete an initial selected-term import, retain parent/step relationships and institution labels, and inspect records with missing optional summaries or status.
- Demonstrate multi-page collection and recovery from interruption without prematurely advancing a checkpoint or duplicating records, discoveries, or versions.
- Demonstrate independent step updates, changed-state retention, unchanged-record replay, and separation of source update time, document date, and observation time.
- Verify the transition from initial import to incremental collection and continued updates for previously selected terms.
- Show a failure in one DIP endpoint alongside successful collection from the other, and inspect both outcomes in the admin.
- Verify multilingual retrieval against proceeding summaries, step text, and processed PDF text, returning source-linked results without answer generation.
- Demonstrate lazy PDF processing: metadata import does not fetch bytes; the 14-day hot subset is queued independently; an on-demand request returns the source link immediately and raises processing priority.

These are the active Phase 1 collection criteria after ADR 0007. The architecture and README describe the target design; the feed catalog is historical. Existing runtime code still exposes news collection.
