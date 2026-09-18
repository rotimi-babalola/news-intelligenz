# Node.js and direct PostgreSQL access for the local collector

Use Node.js 24 LTS, TypeScript, and `pg` (node-postgres), with versioned SQL
migrations. Node's HTTP server serves the small local admin page; its test runner
executes tests. `fast-xml-parser` parses the configured RSS 2.0 feed. No paid
service, ORM, frontend framework, or separate queue is needed for this ticket.

This follows [ADR 0002](0002-postgresql-for-storage-and-jobs.md): collection data
and operational records live in PostgreSQL. Use parameterized queries and one
client per transaction, as required by the
[node-postgres transaction API](https://node-postgres.com/features/transactions).
SQL keeps identity constraints and replay semantics explicit. Future durable jobs
remain in PostgreSQL; scheduling, extraction and recovery workers are later tickets.

[Node's release policy](https://nodejs.org/en/about/previous-releases) supports an
LTS runtime for application use. Local infrastructure uses PostgreSQL 17 in Docker
with a persistent volume. Integration tests use isolated database schemas.

Implementation increments: validate RSS metadata; persist one run atomically;
inspect persisted records locally; verify process restart and replay. The first
source runs exclusively against synthetic fixtures while retention is unresolved.
