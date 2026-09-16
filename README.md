# News Intelligenz

News Intelligenz aims to help immigrants living in Germany understand the country's news and government activity through English explanations. Coverage focuses on politics and everyday life, including employment, housing, healthcare and education—not only immigration.

## Project status

Phase 1 design is confirmed and its implementation is tracked in [12 GitHub issues labelled Phase 1](https://github.com/rotimi-babalola/news-intelligenz/issues?q=is%3Aissue%20label%3A%22Phase%201%22). The repository currently contains design documentation; there is no runnable application or installation workflow yet.

## Phase 1: news collection

The first deliverable is a fault-tolerant pipeline that collects, validates, processes and stores news with traceable discovery history. It includes an internal admin tool for one operator. English explainers and a reader-facing experience come later.

### Sources

- **34 configured RSS feeds:** Tagesschau all updates, eight Deutschlandfunk feeds and 25 Bundestag feeds. See the [complete feed catalog](docs/phase-1-feed-catalog.md).
- **Targeted search agents:** six fixed German queries covering politics/legislation, employment/economy, housing, healthcare, education and immigration. Initial searches are restricted to `tagesschau.de` and `deutschlandfunk.de`.

All valid items from configured feeds are eligible without relevance filtering. Search results are assessed for relevance to Germany, with uncertain candidates held for manual review. German and English source material is preserved without translation.

### Planned behaviour

- Collect daily at **07:00 Europe/Berlin**, with six hours of overlap and independent recovery progress for each feed and search query.
- Store publications, text versions, discoveries, processing jobs and review decisions in **PostgreSQL**.
- Extract article text from linked pages where source permissions allow; retain permitted metadata and original links when extraction fails or a format is unsupported.
- Deduplicate the same publication using identifiers and resolved URLs while keeping different publishers' reporting separate.
- Preserve changed article text as versions, recheck recently discovered publications and refresh older ones when rediscovered.
- Recover interrupted processing through durable jobs and retries, support manual backfills and expose unresolved gaps and failures.
- Provide an internal inspection page, relevance review and reversible duplicate merges. Protect deployed admin access with Basic Auth over HTTPS.
- Measure source contributions, extraction outcomes, search relevance and resource usage. Explore free tiers first and pause affected providers when allowances run out.

Source endpoints, formats and retention permissions still require validation. Runtime, search provider and hosting selections will be documented during implementation research.

### Completion criteria

Phase 1 requires seven consecutive scheduled runs, demonstrated persistence and recovery, idempotent replays, working review flows, a manually checked sample of 30 items, and a report of search's contribution beyond RSS. See the [full acceptance criteria](docs/phase-1-design-notes.md#agreed-completion-criteria).

## Documentation

| Document | Purpose |
| --- | --- |
| [Phase 1 architecture](docs/phase-1-architecture.md) | Agreed scope, collection flow and operational behaviour |
| [Design notes](docs/phase-1-design-notes.md) | Decisions, acceptance criteria and unresolved factual checks |
| [Feed catalog](docs/phase-1-feed-catalog.md) | Exact launch feed URLs |
| [Domain glossary](CONTEXT.md) | Shared terminology for publications, versions and discoveries |
| [ADR: publication versions](docs/adr/0001-preserve-publication-versions.md) | Why historical article text is retained |
| [ADR: PostgreSQL storage and jobs](docs/adr/0002-postgresql-for-storage-and-jobs.md) | Why persistent data and durable jobs share a database |

## Implementation roadmap

Start with [issue #1: collect and inspect one RSS feed locally](https://github.com/rotimi-babalola/news-intelligenz/issues/1), then follow the **Blocked by** references in the [Phase 1 issues](https://github.com/rotimi-babalola/news-intelligenz/issues?q=is%3Aissue%20label%3A%22Phase%201%22). Each issue includes a description and acceptance criteria.

Future phases may add English explainers, coverage of all 16 state parliaments, additional publishers and reader-facing features. Event clustering, embeddings and semantic search are outside Phase 1.
