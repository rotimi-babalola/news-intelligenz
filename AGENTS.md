## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `rotimi-babalola/news-intelligenz`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout at the repo root. See `docs/agents/domain.md`.

### `src/dip` module layout

`src/dip` is organised by concern. Do not add new flat files at its root; put a file in the existing folder that owns the behaviour.

- `collection/` — DIP `/vorgang` and `/vorgangsposition` collection, checkpoints, source versions, schedules, and raw payload parsing.
- `documents/` — PDF fetch/extraction, chunks, sections, excerpts, object storage, processing, and section verification.
- `search/` — embedding provider, vector search, dossier assembly, and relevance evaluation.
- `proceedings/` — proceeding timeline read model.
- `jobs/` — DIP job operations, embedding worker, and reindex.
- `db/` — every Prisma read and write, split by entity; import through `db/index`.
- `explain/` — brief generation, provider calls, evidence collection, citation/claim validation, and answer assembly.
- `constants.ts` — shared tunables, endpoints, job names, and limits; look here before adding a new literal.

Each file owns one concern. Split a file when it grows a second responsibility instead of adding a shared `util`. A folder's `index.ts` is only its public entry point, never a place for new logic.

### Parliamentary research

For questions about DIP proceedings, steps, or documents, check for the `news-intelligenz` MCP server and use its `get_proceeding`, `search_dip_evidence`, or `get_document_pages` tool first, as appropriate. See the MCP setup in `README.md`. If the server is unavailable, the record is missing, or fresh information is needed, consult official DIP sources and say explicitly why the MCP server could not answer.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
