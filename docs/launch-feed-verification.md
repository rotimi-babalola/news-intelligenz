# First feed: Bundestag — Aktuelle Themen

Checked on 18 September 2026. The
[official directory](https://www.bundestag.de/services/rss/feeds_allgemein-249014)
links to the [configured endpoint](https://www.bundestag.de/static/appdata/includes/rss/aktuellethemen.rss).
An HTTPS fetch returned RSS 2.0 XML with UTF-8, channel language `de`, item titles,
links, descriptions and Dublin Core metadata. Feed descriptions can contain
substantial article text, so treating the complete XML as harmless metadata would
be incorrect. No fetched source content is committed as a fixture.

The [Bundestag usage terms](https://www.bundestag.de/services/impressum)
restrict general website content to private downloading/printing unless a
specific exception applies. They do not clearly establish permission for this
project's persistent news metadata collection. The exception for parliamentary
papers/protocols does not establish permission for Aktuelle Themen articles.

**Decision: live collection disabled.** Metadata retention and full-text retention
remain unresolved. The runnable feed uses authored synthetic RSS fixtures with
German and English titles and reserved `example.org` links. The admin page labels
these as fixtures. Only selected metadata is persisted; descriptions and article
text are not collected. Enabling the real endpoint requires documenting applicable
metadata permission and adding a reviewed fetch path. No environment flag bypasses
this restriction.
