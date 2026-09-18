# Collect and inspect one RSS feed locally

## Acceptance evidence

- Runtime/database choice: Node.js 24 LTS, TypeScript, node-postgres and
  PostgreSQL 17; [ADR 0003](adr/0003-local-runtime-and-database-access.md).
- Launch feed: Bundestag Aktuelle Themen endpoint and RSS 2.0 format checked;
  metadata retention remains unresolved. Synthetic fixtures are the only enabled
  input. See [the source report](launch-feed-verification.md).
- Persistence: SQL tables store runs, selected candidate metadata and validation
  errors, publications, publisher-scoped identifiers and distinct discoveries.
  One transaction commits a run. No description or full text is retained.
- Inspection: local page shows headline, publisher, original URL, publication and
  discovery dates, metadata-only content availability, run results and candidate
  errors. Source German/English text is preserved without translation.
- Restart/replay: `test/persistence.integration.ts` launches and exits the CLI,
  starts/stops/restarts the admin process, compares the page before and after,
  and asserts all persisted rows are unchanged after replay in a new process.
  A new run yields new discoveries without new publications.

## Additional checks

The integration test covers concurrent identical runs, changed-input rejection,
duplicate feed entries, conflicting identities, failed XML parsing, injected SQL
failure with complete rollback, HTML escaping, and local/read-only HTTP access.
Unit tests cover German/English text, missing dates, rejected candidate metadata,
malformed/oversized XML, and rejection of entity/DOCTYPE declarations.

Manual browser verification covers the populated page and selecting a run to
inspect its rejected candidate. The database uses a persistent Compose volume.
The automated restart proof covers application processes, not a database crash
or host reboot. This ticket does not claim live feed operation, full-text
extraction, scheduling, historical completeness, or durable job recovery.
