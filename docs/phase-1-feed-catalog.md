# Phase 1 feed catalog

Launch RSS selection under the [DIP amendment](dip-design-notes.md): nine public-news feeds. DIP `/vorgang` and `/vorgangsposition` replace the 25 previously selected Bundestag feeds. Endpoints and formats require live validation during implementation; listing does not claim they have been verified. Retain each feed's discovery provenance even when items overlap. All valid configured feed items are eligible without relevance filtering, including sport, culture and international coverage.

The first local implementation enables the Deutschlandfunk Nachrichten feed with
metadata-only retention (headline, dates, URL, `guid`), keeps the Bundestag
Aktuelle Themen endpoint disabled with retention unresolved, and uses the
synthetic Bundestag fixture as the deterministic parser and persistence test; see
the [verification report](launch-feed-verification.md). Feed tags such as
`de-DE` normalize to their primary language subtag.

## Public-news feeds

- [tagesschau (ARD) – all updates](https://www.tagesschau.de/infoservices/alle-meldungen-100~rdf.xml)
- [Deutschlandfunk – Nachrichten](https://www.deutschlandfunk.de/nachrichten-100.rss)
- [Deutschlandfunk – Politik](https://www.deutschlandfunk.de/politikportal-100.rss)
- [Deutschlandfunk – Wirtschaft](https://www.deutschlandfunk.de/wirtschaft-106.rss)
- [Deutschlandfunk – Wissen](https://www.deutschlandfunk.de/wissen-106.rss)
- [Deutschlandfunk – Kultur](https://www.deutschlandfunk.de/kulturportal-100.rss)
- [Deutschlandfunk – Europa](https://www.deutschlandfunk.de/europa-112.rss)
- [Deutschlandfunk – Gesellschaft](https://www.deutschlandfunk.de/gesellschaft-106.rss)
- [Deutschlandfunk – Sport](https://www.deutschlandfunk.de/sportportal-100.rss)

## Former Bundestag selection (historical; excluded from launch)

These URLs record the superseded RSS selection. The existing synthetic RSS fixture remains a parser test; it does not authorize live collection from these feeds.

- [Aktuelle Themen](https://www.bundestag.de/static/appdata/includes/rss/aktuellethemen.rss)
- [Arbeit und Soziales](https://www.bundestag.de/static/appdata/includes/rss/arbeitsoziales.rss)
- [Auswärtiges](https://www.bundestag.de/static/appdata/includes/rss/auswaertiges.rss)
- [Bildung, Familie, Senioren, Frauen und Jugend](https://www.bundestag.de/static/appdata/includes/rss/familie.rss)
- [Digitales und Staatsmodernisierung](https://www.bundestag.de/static/appdata/includes/rss/digitales.rss)
- [Europäische Union](https://www.bundestag.de/static/appdata/includes/rss/eu.rss)
- [Finanzen](https://www.bundestag.de/static/appdata/includes/rss/finanzen.rss)
- [Forschung, Technologie, Raumfahrt und Technikfolgenabschätzung](https://www.bundestag.de/static/appdata/includes/rss/bildung.rss)
- [Gesundheit](https://www.bundestag.de/static/appdata/includes/rss/gesundheit.rss)
- [Haushalt](https://www.bundestag.de/static/appdata/includes/rss/haushalt.rss)
- [Inneres](https://www.bundestag.de/static/appdata/includes/rss/inneres.rss)
- [Kultur und Medien](https://www.bundestag.de/static/appdata/includes/rss/kultur.rss)
- [Landwirtschaft, Ernährung und Heimat](https://www.bundestag.de/static/appdata/includes/rss/landwirtschafternaehrung.rss)
- [Menschenrechte und humanitäre Hilfe](https://www.bundestag.de/static/appdata/includes/rss/menschenrechte.rss)
- [Petitionen](https://www.bundestag.de/static/appdata/includes/rss/petitionen.rss)
- [Recht und Verbraucherschutz](https://www.bundestag.de/static/appdata/includes/rss/recht.rss)
- [Sport und Ehrenamt](https://www.bundestag.de/static/appdata/includes/rss/sport.rss)
- [Tourismus](https://www.bundestag.de/static/appdata/includes/rss/tourismus.rss)
- [Umwelt, Klimaschutz, Naturschutz und nukleare Sicherheit](https://www.bundestag.de/static/appdata/includes/rss/umwelt.rss)
- [Verkehr](https://www.bundestag.de/static/appdata/includes/rss/verkehr.rss)
- [Verteidigung](https://www.bundestag.de/static/appdata/includes/rss/verteidigung.rss)
- [Wahlprüfung, Immunität und Geschäftsordnung](https://www.bundestag.de/static/appdata/includes/rss/wahlpruefung.rss)
- [Wirtschaft und Energie](https://www.bundestag.de/static/appdata/includes/rss/wirtschaft.rss)
- [Wirtschaftliche Zusammenarbeit und Entwicklung](https://www.bundestag.de/static/appdata/includes/rss/entwicklung.rss)
- [Wohnen, Stadtentwicklung, Bauwesen und Kommunen](https://www.bundestag.de/static/appdata/includes/rss/bauwohnenstadtentwicklungkommunen.rss)
