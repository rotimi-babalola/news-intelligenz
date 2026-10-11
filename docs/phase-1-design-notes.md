# Phase 1 design interview

These notes preserve the original confirmed design interview. The confirmed [DIP amendment](dip-design-notes.md) supersedes the Bundestag RSS source, publication-only model, and institutional collection details below: nine public-news RSS feeds remain, and DIP proceedings and steps supply parliamentary activity. The [Phase 1 architecture](phase-1-architecture.md) incorporates that amendment. These interviews do not authorize implementation.

## Original agreed direction (see DIP amendment above)

Phase 1 deliverable: a fault-tolerant collection system combining targeted search agents, parliamentary discovery and direct RSS feeds into a validated, deduplicated and traceable stream of German news content. It collects, processes, and stores news according to a shared schema. There is no reader-facing product in this phase; the inspection page is an internal operational tool.

- Serve immigrants living in Germany who want to understand news and government activity through English explainers.
- Collect news about Germany from German public news sources, plus Bundestag data through its RSS feeds.
- Use public-news RSS feeds and fixed search queries run by a search agent. Experimenting with search agents is an explicit project objective.
- Drop the News Gap Agent from Phase 1 because its purpose needs more clarity.
- Cover politics and everyday life in Germany, including healthcare; do not limit coverage to immigration.
- Limit initial institutional collection to Bundestag RSS, alongside public-news sources.
- Keep search queries and permitted domains fixed. The search agent assesses candidate relevance and records its reason.
- Collect daily at 07:00 Europe/Berlin, following local daylight-saving changes, with six hours of overlap. Track recovery separately for each feed and search query so partial collector success does not conceal missed work.
- Explore free tiers first and measure actual usage. There is no agreed spending cap or commitment to paid services; the earlier provisional €30 target is superseded. Revisit paid options when evidence warrants them.
- Attempt full-text extraction from RSS article links. Retain metadata and the original article link when extraction fails; readers should be able to visit the original publication.
- Include all items from configured public-news and Bundestag feeds without item-level relevance filtering. Feed membership is an inclusion policy, not proof that each item concerns Germany.
- Constrain search results to reporting relevant to Germany. Launch search is restricted to `tagesschau.de` and `deutschlandfunk.de`; add approved non-public publishers after evaluating this RSS/search baseline.
- Preserve successive text versions under one publication identity when article content changes.
- Pause an affected provider when its free allowance is exhausted, continue RSS collection, and report the limitation. Do not automatically incur charges.
- Evaluate search as a learning experiment and as a complement to RSS: measure relevant additional publications, erroneous relevance decisions, and usage.
- Restrict search to a configurable publisher-domain allowlist that can support public and approved non-public publishers.
- Automatically merge publications only when publisher-scoped identifiers or resolved article URLs establish identity. Similar titles flag possible duplicates for inspection rather than automatic merging.
- Recheck publications discovered within the previous three days during daily collection, and older publications whenever RSS or search surfaces them again.
- Recover missed collection windows from each collector's last successful window, with overlap. Attempt catch-up and report unresolved gaps; historical RSS recovery may be incomplete.
- Include a minimal internal inspection page showing headline, publisher, date, extraction status, and original link.
- Include a possible-duplicate review queue with side-by-side comparison, merge, and keep-separate actions. Merges preserve original records, discovery history, and text versions, record the decision, and can be reversed.
- For Bundestag entries, collect only the directly linked resource. Extract HTML text where possible and retain metadata and links for unsupported formats; following linked document chains is deferred.
- Preserve each distinct feed or search-query encounter as discovery provenance; retries must not duplicate the same encounter.
- Keep search candidates with uncertain relevance and their reasoning in an internal review queue. They do not become accepted publications until reviewed. RSS has no relevance-review requirement.
- Develop and validate locally, then deploy the scheduled collector to an always-on environment. Compare suitable free tiers before selecting hosting.
- Accept German and English source material, preserving original text and language without translation during collection.
- Persistent storage is explicitly part of Phase 1: publications, text versions, discovery history, run results, and review decisions must survive restarts.
- The internal admin tool has one operator. Start locally and deploy it alongside always-on operation, protected by Basic Auth; registration and multi-user roles are deferred.
- Launch RSS sources: the user-provided [34-feed catalog](phase-1-feed-catalog.md), comprising Tagesschau all updates, eight Deutschlandfunk feeds, and 25 Bundestag feeds. This explicitly supersedes the earlier five-feed selection. Defer DW and parliamentary document feeds.
- Use PostgreSQL for publications, versions, discoveries, processing jobs, and review decisions. Begin with database-backed durable jobs rather than a separate queue service.
- Start with one configurable German search query per day for each of six subjects: politics/legislation, employment/economy, housing, healthcare, education, and immigration.
- Check applicable retention and reuse permissions per source before enabling retained full-text versions. Where unresolved, retain only permitted metadata and links; do not assume all metadata retention is permitted by default.
- Delegate remaining technical selections (runtime, search provider, hosting, exact query wording, and bounded retry settings) to implementation research, guided by free-tier availability and measured results. Document selections and reasoning; revisit payment or scope changes with the user.

## Agreed completion criteria

These original criteria remain applicable; the [DIP verification criteria](dip-design-notes.md#verification-criteria) supplement them for parliamentary collection.

- Seven consecutive scheduled runs with inspectable results and failures.
- Repeating a run creates no duplicate publications or discovery encounters.
- Demonstrated recovery from a failed source and interrupted processing.
- Verified article updates, reversible duplicate merges, and relevance review.
- A manually checked sample of 30 items across RSS and search, covering extraction quality and provenance.
- A report of search's additional relevant publications and resource usage; small additional coverage is not itself a failure.
- Collected data and operational records persist across restarts. These checks do not establish exhaustive news coverage.

## Future architecture scope

- Generate English explainers that make the original reporting understandable. Phase 1 collects source material; it does not generate explainers. Broader contextual or personal-impact analysis is not an agreed requirement.
- Add coverage of the state parliaments of all 16 Bundesländer. Initial Bundestag coverage must not be described as comprehensive government coverage.
- Keep future explainers as downstream consumers of collected material and state-parliament coverage as an extension of collection. Detailed interfaces and storage choices remain unresolved.

## Design review status and implementation prerequisites

- The original Phase 1 decisions are supplemented by the accepted DIP retrieval and PDF-processing amendments in [DIP design notes](dip-design-notes.md). Runtime implementation remains pending and is tracked in the linked GitHub issues.
- Source-specific permission checks and live feed validation remain factual implementation prerequisites, not settled findings. No manual-maintenance commitment has been agreed.

## Source research (16 September 2026)

Official directories have been inspected; live feed parsing and linked-page extraction have not yet been validated.

- [Tagesschau RSS](https://www.tagesschau.de/infoservices/rssfeeds): general and topic feeds, including domestic news and economy. The directory states private/noncommercial use and publication restrictions; [an older official page](https://www.tagesschau.de/rssfeed-ts-104.html) also restricts archiving. Resolve applicable permissions before assuming full-text version retention for this source.
- [Deutschlandfunk RSS](https://www.deutschlandfunk.de/rss-angebot-102.html): news and topic feeds.
- [Bundestag RSS](https://www.bundestag.de/services/rss/feeds_allgemein-249014): current topics and hib parliamentary news are distinct from papers and plenary-protocol feeds. Current topics and hib are selected for launch.
- [DW RSS directory](https://corporate.dw.com/en/rss-feeds/a-68693346): tool access was blocked; availability and content remain unverified.
- [Tavily credits](https://docs.tavily.com/documentation/api-credits) and [Exa pricing](https://exa.ai/pricing) both document free allowances; final provider selection remains open and pricing must be rechecked before implementation.

The publication-version decision is recorded in `docs/adr/0001-preserve-publication-versions.md` because overwriting collected text would irreversibly lose the evidence behind future explainers.
