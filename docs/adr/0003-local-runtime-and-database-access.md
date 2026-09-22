# Node.js and Prisma with PostgreSQL for the local collector

Use Node.js 24 LTS, TypeScript, and Prisma ORM against PostgreSQL 17. Prisma
generates the typed client from `prisma/schema.prisma`; the `prisma` CLI owns
versioned migrations in `prisma/migrations`. The runtime uses the
`@prisma/adapter-pg` driver adapter (Prisma is not embedded in a server or
framework here). Node's HTTP server serves the small local admin page; its test
runner executes tests. `fast-xml-parser` parses the configured RSS 2.0 feed. No
paid service, frontend framework, or separate queue is needed for this ticket.

This follows [ADR 0002](0002-postgresql-for-storage-and-jobs.md): collection data
and operational records live in PostgreSQL. Prisma keeps the schema and client
types in one place, applies one migration per revision, and scopes test runs to
isolated database schemas via the driver adapter's `schema` option. One client
per transaction, plus a session-level advisory lock, keeps identity constraints
and replay semantics explicit. Future durable jobs remain in PostgreSQL;
scheduling, extraction and recovery workers are later tickets.

[Node's release policy](https://nodejs.org/en/about/previous-releases) supports an
LTS runtime for application use. Local infrastructure uses PostgreSQL 17 in Docker
with a persistent volume. Integration tests create a schema, apply
`prisma migrate deploy` into it with `DATABASE_URL?schema=<name>`, and drop the
schema on completion. The adapter applies the `schema` option to ORM queries;
raw SQL statements in tests use fully qualified schema names.

Implementation increments: validate RSS metadata; persist one run atomically;
inspect persisted records locally; verify process restart and replay. The
configured source collects the Deutschlandfunk Nachrichten live feed with
metadata only, while the synthetic Bundestag fixture remains the deterministic
parser and persistence test.
