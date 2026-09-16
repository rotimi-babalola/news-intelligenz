# Phase 1 collection architecture

Status: confirmed by the user following the design interview. This is the agreed Phase 1 scope and architecture; implementation and deployment remain deferred and are not authorized by this design confirmation.

## Deliverable

A fault-tolerant collection system combining targeted search agents, parliamentary discovery and direct RSS feeds into a validated, deduplicated and traceable stream of German news content. Persistent storage and a single-operator internal admin tool are included. No reader-facing product or English generation is included.

## Collection and processing

1. Schedule collection at 07:00 Europe/Berlin with six hours of overlap, retaining independent progress for each feed and search query.
2. Discover items through selected public-news and Bundestag RSS feeds, and six fixed German search queries restricted to allowed publisher domains. Search assesses relevance and records reasons; configured RSS items are included without relevance filtering.
3. Validate and durably record candidates and distinct discovery encounters. Invalid candidates remain inspectable. Uncertain search relevance goes to manual review.
4. Process with PostgreSQL-backed jobs. Normalize metadata and identify publications through publisher-scoped identifiers or resolved article URLs. Conflicting identities must remain inspectable rather than force a merge.
5. Where source permissions allow, fetch the directly linked resource and extract HTML article text. Preserve metadata and the original URL when extraction fails; unsupported formats do not require document-chain traversal or PDF extraction.
6. Resolve any identity information obtained during extraction before final storage. Preserve text changes as versions under the same publication; title similarity alone only flags a possible duplicate.
7. Persist publications, allowed text versions, discoveries, run results, review decisions, and processing state in PostgreSQL. Retries and repeated runs must be idempotent.

New discovery encounters in genuinely new runs remain traceable; replaying the same run must not duplicate encounters. Publication dates, discovery times, and version observation times serve different purposes and must not be conflated.

## Initial inputs

RSS selections: the user-provided [34-feed catalog](phase-1-feed-catalog.md): Tagesschau all updates, eight Deutschlandfunk feeds, and 25 Bundestag feeds. This replaces the earlier five-feed selection; exact endpoints and formats require live validation. All valid configured feed items remain eligible without relevance filtering. DW, papers/protocol feeds, and state-parliament collection are deferred.

Search subjects: politics/legislation, employment/economy, housing, healthcare, education, and immigration. Launch search domains are `tagesschau.de` and `deutschlandfunk.de`, enabling evaluation against RSS from the same publishers. The configurable allowlist can later include approved non-public publishers after that baseline evaluation. German and English content is accepted without translation.

Runtime, search provider, hosting, exact query wording, and bounded retry settings are delegated to implementation research. Document choices against free-tier availability and measured results; payment or scope changes require revisiting the choice with the user. Source permissions and live feed/extraction behaviour remain to be verified.

## Reliability and operations

- Use durable jobs, bounded retries, independent source failures, inspectable exhausted failures, and manual recovery/backfill.
- Recheck publications discovered in the previous three days, and older publications when rediscovered, subject to source permissions.
- Resume missed windows from each feed/query's successful progress and report unresolved gaps. Do not claim historical completeness from finite RSS feeds.
- Pause providers when free allowances run out, continue independent RSS work, and expose the limitation. No automatic paid usage is authorized.
- Begin locally; deploy collection and the admin tool to an always-on environment after validation and hosting comparison. Protect the deployed single-operator tool with Basic Auth over HTTPS.

## Internal admin

Inspect headlines, publisher, dates, extraction state, original links, run results, and failures. Review uncertain search relevance. Compare possible duplicates side by side, merge reversibly while preserving original records and provenance, or keep separate. Retain review decisions.

## Acceptance and future extensions

Acceptance criteria are recorded in [design notes](phase-1-design-notes.md#agreed-completion-criteria), including seven scheduled runs, recovery and idempotence checks, a 30-item manual sample, and measured search contribution/usage.

English explainers are future downstream consumers of versioned source material. Coverage of all 16 state parliaments is a future collection extension. The News Gap Agent, event clustering, embeddings, semantic search, and reader-facing features are outside Phase 1.

Source permissions must be checked before full-text retention is enabled; where unresolved, retain only permitted metadata and links. PostgreSQL and text-version decisions are recorded in [ADR 0002](adr/0002-postgresql-for-storage-and-jobs.md) and [ADR 0001](adr/0001-preserve-publication-versions.md).
