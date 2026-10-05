# Launch feeds: nine public-news RSS feeds

Checked on 22 September 2026 with `cli verify-all`. All nine configured
endpoints returned XML over HTTPS (HTTP 200) and every entry parsed as valid,
with headlines and original URLs intact. No endpoint was broken, so nothing
was substituted or dropped. Entry counts are live snapshots and change between
fetches.

| Feed                         | Format                                                         | Entries | Valid |
| ---------------------------- | -------------------------------------------------------------- | ------- | ----- |
| tagesschau alle-meldungen    | RDF (RSS 1.0) with `content:encoded`, `dc:date`, `dc:language` | 40      | 40    |
| Deutschlandfunk Nachrichten  | RSS 2.0, channel `<language>de-DE</language>`                  | 44      | 44    |
| Deutschlandfunk Politik      | RSS 2.0                                                        | 21      | 21    |
| Deutschlandfunk Wirtschaft   | RSS 2.0                                                        | 200     | 200   |
| Deutschlandfunk Wissen       | RSS 2.0                                                        | 200     | 200   |
| Deutschlandfunk Kultur       | RSS 2.0                                                        | 42      | 42    |
| Deutschlandfunk Europa       | RSS 2.0                                                        | 30      | 30    |
| Deutschlandfunk Gesellschaft | RSS 2.0                                                        | 100     | 100   |
| Deutschlandfunk Sport        | RSS 2.0                                                        | 111     | 111   |

Items carry titles, item links, `guid` identifiers and `pubDate` timestamps;
the tagesschau feed additionally uses `dc:date` and per-item `dc:language`.
Feed descriptions and `content:encoded` blocks contain teaser and article
text, so treating the complete XML as harmless metadata would be incorrect;
**no feed descriptions or encoded content are retained**.

The [Deutschlandfunk RSS page](https://www.deutschlandfunk.de/rss-100.html)
documents the feed family. The
[Deutschlandradio usage terms](https://www.deutschlandfunk.de/nutzungsbedingungen-102.html)
(rechecked 22 September 2026, HTTP 200) reserve all rights: reproducing or
translating content, including texts or parts of texts, requires prior written
consent from Deutschlandradio, with no explicit metadata exception. The
[tagesschau RSS directory](https://www.tagesschau.de/infoservices/rssfeeds)
(rechecked 22 September 2026, HTTP 200) permits use of content only for
private, non-commercial purposes and forbids publication except for offers
explicitly under a CC licence. On 5 October 2026, the operator confirmed that
this project is private and non-commercial and approved local extraction and
retention of fetched article text from the nine configured news-feed hosts.
This records the project's operating decision, without claiming a right to
republish that text. The current behavior is:

- RSS intake persists only headline, dates, URL and `guid` for all nine feeds;
  it does not retain feed excerpts or encoded content.
- Fetched article text is stored as versions for links on the nine configured
  news-feed hosts when extraction succeeds. Redirects to other hosts and
  unsupported formats retain metadata and the original link only.
- All Bundestag RSS endpoints remain **disabled** (see the
  [feed catalog](phase-1-feed-catalog.md)); the synthetic Bundestag fixture
  stays a deterministic parser and persistence test, as does the synthetic
  tagesschau RDF fixture (`fixtures/tagesschau-rdf.xml`).

Custom feed hosts are not added to the article-text allowlist. The admin page labels
fixture inputs as "Synthetic Bundestag fixture" and live inputs by feed. Live
feed inputs change between snapshots, so reusing a run ID against a changed
feed is rejected as a different input; identical-input replay is demonstrated
with the fixture. `collect-all` records each feed as its own run, so one
feed's fetch failure or malformed entries leave the other feeds' results
intact and every feed's outcome inspectable.
