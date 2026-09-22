# Collect and inspect one RSS feed locally

## Acceptance evidence

- Runtime/database choice: Node.js 24 LTS, TypeScript, Prisma ORM and
  PostgreSQL 17; [ADR 0003](adr/0003-local-runtime-and-database-access.md).
- Launch feed: Deutschlandfunk Nachrichten endpoint and RSS 2.0 format verified;
  metadata retention enabled, full-text retention unresolved. The synthetic
  Bundestag fixture remains the deterministic parser and persistence input.
  See [the source report](launch-feed-verification.md).
- Persistence: Prisma models and `prisma/migrations` store runs, selected
  candidate metadata and validation errors, publications, publisher-scoped
  identifiers and distinct discoveries. One transaction commits a run with an
  advisory lock. No description or full text is retained.
- Inspection: local page shows headline, publisher, original URL, publication and
  discovery dates, metadata-only content availability, run results and candidate
  errors. Source German/English text is preserved without translation.
- Restart/replay: `test/persistence.integration.ts` launches and exits the CLI,
  starts/stops/restarts the admin process, compares the page before and after,
  and asserts all persisted rows are unchanged after replay in a new process.
  A new run yields new discoveries without new publications.

## Additional checks

The integration test runs in an isolated schema created and dropped by the test,
applies the Prisma migrations into it, and covers concurrent identical runs,
changed-input rejection, duplicate feed entries, conflicting identities, failed
XML parsing, injected SQL failure with complete rollback, HTML escaping, and
local/read-only HTTP access. Unit tests cover German/English text and BCP-47
language normalization, missing dates, rejected candidate metadata,
malformed/oversized XML, and rejection of entity/DOCTYPE declarations.

Manual browser verification covers the populated live and fixture runs and
selecting a run to inspect its rejected candidate. The database uses a persistent
Compose volume. The automated restart proof covers application processes, not a
database crash or host reboot. This ticket does not claim full-text extraction
(blocked on feed terms), scheduling, historical completeness, or durable job
recovery.
