# DIP collection design interview

Status: all nine interview decisions and the consolidated amendment confirmed by the user. Implementation is not part of this interview.

## Settled decisions

- Replace Bundestag RSS collection with DIP API collection. Keep the public-news RSS sources.
- Use `/vorgang` as the entry point for parliamentary proceedings and their summaries and deliberation status. Collect individual proceeding steps through `/vorgangsposition` as evidence of developments.
- Include all proceeding types in the current electoral term, rather than restricting collection to legislation.
- Treat proceedings and proceeding steps as distinct domain concepts; a proceeding is not itself an article or institutional document.
- Initially import the full current electoral term and its proceeding steps, then collect incremental updates. This imports the states available at collection time; it cannot reconstruct earlier unobserved revisions.
- Retain structured API metadata, available summaries, proceeding steps, and document references. Defer linked document-text retrieval. Records without summaries remain metadata-only.
- Preserve changed states of proceedings and steps. An API record update is a data change, not by itself evidence of a new parliamentary event; documented proceeding steps provide evidence of developments.
- Collect all proceedings returned for selected electoral terms and retain all their steps, labeled by institution. Coverage includes Bundestag, Bundesrat, Bundesversammlung, and Europakammer activity; call the source parliamentary activity.
- Keep daily collection at 07:00 Europe/Berlin with six hours of overlap. Track proceedings and steps independently by update timestamp. Advance each checkpoint only after all pages are durably stored; retries do not block independent news collection.
- Add new electoral terms explicitly and continue checking previously included terms for updates. Do not automatically import every historical term.
- Provide an internal proceeding list and detail view with summary, status, steps, document references, retained versions, collection progress, and failures. Keep articles separate; automatic linking of reporting to proceedings is deferred.

## API evidence

Source: user-supplied DIP OpenAPI specification, version 1.5 (`/Users/rotimibabalola/Downloads/openapi.yaml`).

- `Vorgang.aktualisiert` is the entity's last update timestamp; it does not identify the reason for the update.
- `Vorgang.datum` dates its latest associated document. Date filters for proceedings use the date range of associated documents.
- Both collection endpoints support update-time filters and cursor pagination. Subsequent pages repeat the original parameters and pass the returned cursor; pagination ends when the cursor stops changing.
- Proceeding steps reference their parent through `vorgang_id`.
- Both endpoints support electoral-term filters, but step payloads do not contain an electoral-term field. Verify how step filtering relates to parent proceedings and cross-term documents; retain unresolved parent references for inspection rather than discarding steps.
- IDs are numeric strings; preserve them as strings. Summaries and proceeding status are optional. A step's displayed activity list is limited to four entries and must not be described as complete person/activity coverage.

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

## Verification criteria

- Complete an initial selected-term import, retain parent/step relationships and institution labels, and inspect records with missing optional summaries or status.
- Demonstrate multi-page collection and recovery from interruption without prematurely advancing a checkpoint or duplicating records, discoveries, or versions.
- Demonstrate independent step updates, changed-state retention, unchanged-record replay, and separation of source update time, document date, and observation time.
- Verify the transition from initial import to incremental collection and continued updates for previously selected terms.
- Show a DIP failure alongside successful independent public-news collection and inspect both outcomes in the admin.

These supplement the existing Phase 1 acceptance criteria. The architecture, feed catalog, glossary, and README have been reconciled with the amendment; existing runtime code remains the synthetic RSS implementation.
