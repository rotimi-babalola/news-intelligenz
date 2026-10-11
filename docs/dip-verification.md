# DIP verification (Slice 1)

Status: contract + live behavior verified against OpenAPI v1.5 and minimal probes on 2026-10-11. **Live collection is NOT enabled.** Later slices must build against `fixtures/dip/` until the unresolved items below are cleared.

## Contract reference (not permission evidence)

- Source: user-supplied OpenAPI v1.5, `/Users/rotimibabalola/Downloads/openapi.yaml` (also published at `https://search.dip.bundestag.de/api/v1/openapi.yaml`, version 1.5).
- Base URL: `https://search.dip.bundestag.de/api/v1`.
- Endpoints in scope: `GET /vorgang`, `GET /vorgang/{id}`, `GET /vorgangsposition`, `GET /vorgangsposition/{id}`.
- The spec describes the API contract only. It does not establish retention permission or snapshot consistency.

## Authentication — verified

- Every request requires an API key, sent either as `Authorization: ApiKey <key>` header or `?apikey=<key>` query parameter (spec `securitySchemes`; 401 message points to `https://dip.bundestag.de/über-dip/hilfe/api`).
- Verified live on 2026-10-11: `Authorization: ApiKey <BUNDESTAG_API_KEY>` returned `HTTP 200` for `GET /vorgang?f.wahlperiode=21&format=json`.
- The key currently in `.env` (`BUNDESTAG_API_KEY`) is the **public demo key** published on the DIP help page (`R2BZaee.…`, initially valid until end of May 2027). A personal key with an initial ten-year term is available on request; we have not requested one.
- Slice 1 used three minimal read-only probes total (one `/vorgang`, two `/vorgangsposition`, one two-page cursor check). No collection, no PDF fetch.

## Usage / retention terms — resolved

- Terms of service: `https://dip.bundestag.de/über-dip/nutzungsbedingungen`. The DIP help page states use of the DIP database and data taken from DIP is governed by those terms.
- Resolved per user decision (2026-10-11): retaining and publishing DIP data is permitted provided the Bundestag is attributed as the source. Later slices that store or surface DIP records must carry that attribution.
- Live collection itself is still NOT enabled by this slice; later slices build against `fixtures/dip/` until they implement collection, and must not fetch PDF bytes during collection.

## Limits — verified where the contract states them

- Page size: at most 100 `documents` per list response (`maxItems: 100` on both list schemas).
- Cursor pagination: repeat all original query parameters plus the returned `cursor`; continue until the cursor stops changing. Verified live: page 1 (`f.wahlperiode=21`) returned 100 docs with a 32-char cursor; page 2 with that cursor returned 100 more docs and a changed cursor.
- No result sort order is defined in the spec — the local 1,000-record cap (later slice) is a first-encountered cap, not newest-first.
- No published rate limit found in the spec. No `Retry-After` behavior observed (no 429 seen in three probes). Rate-limit handling stays unresolved; later slices must use bounded retries and back off.
- Observed scale (2026-10-11, WP 21): `/vorgang?f.wahlperiode=21` → `numFound` 18781; `/vorgangsposition?f.wahlperiode=21` → `numFound` 31471.

## Live field behavior — verified

- `Vorgang` required: `id` (numeric string), `typ`, `vorgangstyp`, `wahlperiode`, `aktualisiert`, `titel`. Optional: `abstract`, `beratungsstand`, `datum` (latest-document date), desks. `Vorgang` has no `vorgang_id` or `fundstelle`.
- `Vorgangsposition` required includes `id`, `vorgangsposition`, `zuordnung` (BT/BR/BV/EK), `gang`, `fortsetzung`, `nachtrag`, `vorgangstyp`, `typ`, `titel`, `dokumentart`, `vorgang_id`, `datum`, `aktualisiert`, `fundstelle`, `aktivitaet_anzahl`. Verified live: step `701425` links `vorgang_id` `340161`, `zuordnung` `BR`, `fundstelle` carries `id`/`dokumentnummer`/`pdf_url`/`datum`.
- Step payloads carry **no** `wahlperiode` field (confirmed live). Term filtering on steps is therefore unverified against parents — later slices must test it and retain unresolved parents.
- Display list `aktivitaet_anzeige` is capped at 4 entries (`maxItems: 4`) beside a separate `aktivitaet_anzahl` total. Never describe it as full person/activity coverage. Observed: a step with `aktivitaet_anzahl: 0` omits the display list.
- Timestamps use explicit offsets (e.g. `2026-10-09T16:32:14+02:00`). Later slices must send explicit-offset `f.aktualisiert.*` windows; bare local times from spec examples are not authoritative.
- Filters in scope: `f.wahlperiode` (repeatable OR), `f.aktualisiert.start/end` (date-time), `f.vorgang` (step→parent id), `f.zuordnung`, `format=json|xml` (default json). Single-item `GET /vorgang/{id}` and `/vorgangsposition/{id}` exist for missing-context retrieval.

## Unresolved (must clear before live collection)

1. Rate limits / quota / `Retry-After` semantics.
2. Step term-filter semantics vs parent proceedings and cross-term documents.
3. Indexing delay and cursor expiry for `aktualisiert` windows.
4. Deletion semantics (absent records prove nothing).
5. Personal API key request (still on the public demo key).

## Repeatable fixtures

`fixtures/dip/` mirrors the verified shapes without touching live data:

- `vorgang-page1.json` — 3 proceedings: with summary+status, without both (metadata-only tolerance), Bundesrat-initiated; `cursor: CURSOR_PAGE2`.
- `vorgang-page2-terminal.json` — repeats `cursor: CURSOR_PAGE2` (pagination end = cursor stops changing).
- `vorgangsposition-page1.json` — BR step with full `fundstelle`, BT step, cross-term step (`vorgang_id` outside the filtered term), missing-parent step (`vorgang_id` `999999`), and a 4-entry `aktivitaet_anzeige` with `aktivitaet_anzahl: 6` (display cap).
- `test/dip-fixtures.test.ts` pins these invariants so regressions fail loudly.
