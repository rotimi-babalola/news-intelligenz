# First feed: Deutschlandfunk — Nachrichten

Checked on 22 September 2026. The
[Deutschlandfunk RSS page](https://www.deutschlandfunk.de/rss-100.html) documents
the feed family; the [configured endpoint](https://www.deutschlandfunk.de/nachrichten-100.rss)
returned RSS 2.0 XML over HTTPS with UTF-8, a channel `<language>de-DE</language>`,
and items with titles, item links, `guid` identifiers and `pubDate` timestamps.
An HTTPS fetch was repeatedly available. All 33 entries parsed as valid, with
headlines and original URLs intact. Feed descriptions contain teaser text, so
treating the complete XML as harmless metadata would be incorrect; **no feed
descriptions are retained**.

The [Deutschlandradio usage terms](https://www.deutschlandfunk.de/nutzungsbedingungen-102.html)
reserve all rights. They state that saving or storing texts from the
Deutschlandradio websites requires prior written consent from Deutschlandradio,
with no explicit metadata exception. Article text retention is therefore **not
permitted** on the current terms; only the selected feed metadata (headline,
published timestamp, exact original URL, and the feed's `guid`) is persisted,
matching this project's metadata-only record. The definitive distinction:

- Live Deutschlandfunk metadata persistence is **enabled** for the
  configured Nachrichten feed, retaining only headline, dates, URL and `guid`.
- Full-text retention remains **disabled**, pending resolution of the written-
  consent requirement in the usage terms.
- The Bundestag Aktuelle Themen endpoint remains **disabled** (see the
  [feed catalog](phase-1-feed-catalog.md)); its synthetic fixture stays a
  deterministic parser and persistence test.

No environment flag bypasses the full-text restriction. The admin page labels
fixture inputs as "Synthetic Bundestag fixture" and the configured input as
"Live feed: Deutschlandfunk Nachrichten". Live feed inputs change between
snapshots, so reusing a run ID against a changed feed is rejected as a different
input; identical-input replay is demonstrated with the fixture.
