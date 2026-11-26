# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People living in Germany who follow parliamentary news but are not political specialists, especially immigrants who may read German and prefer an explanation in their own language. They arrive with a question they heard in the news and want to understand what parliament is doing about it.

## Product Purpose

Explain parliamentary activity in plain language, grounded in official DIP records. A reader asks a question, gets a short answer, context and a timeline, and can open the cited proceeding step or document page. Success is a reader who understands the matter and can check the source.

## Positioning

Proceeding-centric explainers built from stored DIP evidence, not news summarisation and not an unsourced chatbot. Every claim carries a citation to a proceeding step or document page, and the answer abstains when the stored evidence cannot support it.

## Operating Context

Questions arrive in German or English. DIP proceedings have a type, a deliberation state, a last activity date and ordered steps; steps link to Drucksachen and Plenarprotokolle, and cited PDF pages are stored. The reader interface is local-only today. Operators keep `/admin` and `/admin/briefs-test`.

## Capabilities and Constraints

- `/api/ask` accepts a question, language and optional proceeding; it returns either one answer or a candidate list.
- A clear question should navigate to `/ask`; an ambiguous one must show the proceeding picker and never navigate without a choice.
- English/German toggle. Native HTML, forms and status regions; the pinned `@ui-sdk/react` picker is the only component dependency.
- Search failures need an error with retry; the searching state is a live status.
- Usable at 320 px, keyboard-only, IME-safe submit, visible focus.
- No accounts, saved history or editorial news.

## Brand Commitments

The product name is Klarantwort. `DESIGN.md` at the repository root is the pinned visual system for this surface. Copy is plain and non-partisan, and never implies that DIP covers all German government activity.

## Evidence on Hand

Real query and proceeding fixtures under `fixtures/dip/` (housing costs, emissions allocations, grid charges, care levels, migration and employment, Autobahn funding). Reader answer shape in `docs/architecture/reader-answer-format.md`. No testimonials, customer logos, usage metrics or press quotes exist, and none may be invented.

## Product Principles

- Answer the question first, then show where it comes from.
- Never state a fact the stored evidence does not support.
- German and English are equal readers, not a translation afterthought.
- The reader can leave the answer and reach the original record in one step.
- Calm, credible presentation over persuasion.

## Accessibility & Inclusion

Keyboard operation for the whole flow, focus returned to the question field after the picker closes, 44 px targets, readable at 320 px, visible focus, `role="status"` announcements for searching and errors, and no reliance on colour alone.
