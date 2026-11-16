# Grounded DIP explainers in additional languages, 16 November 2026

Issue [#82](https://github.com/rotimi-babalola/news-intelligenz/issues/82) asks
whether the proceeding dossier and grounded synthesis from #78 and #80 can
produce useful, faithful explainers in languages beyond English and German
without changing the DIP corpus. This spike adds no language option to the
product. The prototype, labels and raw results are fixed artifacts for review;
any production work is a separate issue. `CONTEXT.md` defines an **Explainer** as
an English explanation. This spike deliberately tests the same grounded
synthesis in other languages and does not change that definition; a production
language option would need a separate domain decision about the term.

**Short answer:** the model supports French, Polish and Turkish. Qualification
was correct in every language, and the deterministic orphan abstention path
stayed localized; model abstention was not separately tested. The blockers are
retrieval and the shared citation assembly, not the model's ability to write the
languages. No candidate is ready for a reader-facing pilot. French and Polish
merit a second prototype after the shared fixes below; Turkish is not
recommended now.

## Corpus and cases

The run finished on 2026-11-16. The branch held 3,914 proceedings, 34,045
steps, 1,871 current fetched documents, 40,063 extracted pages and 112,871
embeddings; the latest proceeding and step observations were 14 November
06:02Z. The branch is live, so the per-case corpus record in
[the JSON](run.json) is the authoritative version
and document-byte record.

Five cases were selected from the reviewed English/German set:

| Case                | Proceeding | Why it is representative                                                |
| ------------------- | ---------: | ----------------------------------------------------------------------- |
| Climate allocations |     338509 | Two PDF page facts, EU legal terms, a citation that spans two documents |
| University funding  |     340641 | Three numeric facts on one page                                         |
| Truck toll 2025     |     340174 | The asked fact is absent; qualification must name the missing period    |
| Housing costs       |     339930 | Step-only timeline, procedural terms, no document page                  |
| Lunar minerals      |     325604 | Orphan timeline; the product must abstain rather than invent an answer  |

The English and German questions are the reviewed questions. The French,
Polish and Turkish questions were translated once by the model before retrieval
and generation. The same English-query dossier was forced for every output
language, so an explanation failure cannot be hidden by a different retrieval
result. Retrieval was measured separately with each translated question.

## Model and prompt settings

| Setting               | Value                                                                                |
| --------------------- | ------------------------------------------------------------------------------------ |
| Answer model          | OpenAI `gpt-4o` at `https://api.openai.com/v1`; API reported `gpt-4o-2024-08-06`     |
| Audit model           | OpenAI `gpt-4o-mini`; API reported `gpt-4o-mini-2024-07-18`                          |
| Embedding model       | `text-embedding-3-small`, 1024 dimensions; no tuning or reindexing                   |
| Sampling              | Prototype/audit: `temperature: 0`; en/de: product default; JSON format, 120 s        |
| Answer/verify prompts | `ANSWER_PROMPT`, `VERIFY_PROMPT`, copied verbatim from `src/dip/explain/provider.ts` |
| Translation prompts   | `TRANSLATE_PROMPT`, `TERMS_PROMPT`, copied verbatim, language substituted            |
| Audit prompt          | Spike-only claim audit, shown in `scripts/spike-explain-languages.ts`                |
| English/German        | Product `generateProceedingBrief`                                                    |
| French/Polish/Turkish | Prototype assembly, otherwise the same evidence, citation and quote rules            |

The spike copies the four product prompts verbatim into
`scripts/spike-explain-languages.ts` so no product file changes. The JSON
records the requested model aliases and a full SHA-256 hash of each prompt under
`configuration.promptIdentity`. The resolved snapshots above were
observed in the API response and are not stored per answer.

Every claim was checked twice. The deterministic pass requires an exact quote
in the cited step or page, a valid evidence ID, and target-language text. The
audit pass gives the full cited step record or page text to `gpt-4o-mini` and
asks whether the claim adds an actor, date, number, outcome or inference the
source does not state. All 156 claims and their audit verdicts are in the JSON.
The table in [Claim audit](#claim-audit) lists every claim the audit flagged
and the manual adjudication.

## Retrieval results

The translated query was used only for retrieval in this table. The same
English-query dossier was used for every generated answer.

| Language | Target proceeding in top 5 | Expected evidence retrieved | Observed miss                                     |
| -------- | -------------------------: | --------------------------: | ------------------------------------------------- |
| English  |                        5/5 |                         5/5 | None                                              |
| German   |                        5/5 |                         5/5 | None                                              |
| French   |                        4/5 |                         3/5 | Housing query returned no dossier for case 339930 |
| Polish   |                        4/5 |                         3/5 | Climate query returned no dossier for case 338509 |
| Turkish  |                        4/5 |                         5/5 | Lunar record not in the top 5                     |

These are retrieval limitations, not explanation limitations:

- The climate label's earlier page-290340:4 expectation was stale: the same
  quote is on retrieved page 290322:3, and the reviewed #80 label cites
  290340:3. After removing it, English, German and Turkish retrieve every
  expected piece; there is no shared evidence miss.
- French missed the housing record entirely. The forced-evidence French answer
  still produced a correct, cited housing timeline, so the failure is the query
  translation/retrieval path.
- Polish missed the climate record entirely, with the same result: the
  forced-evidence answer was coherent, so the query, not the dossier, failed.
- Turkish did not return the lunar record in the top 5; all five results were
  unrelated proceedings. A reader would not reach the abstaining record.
- Query translation is weaker than answer generation. The French and Polish
  university queries kept the English phrase "universities of applied
  sciences"; the Turkish query used the German "Fachhochschulen". Retrieval
  happened to survive those mixed queries. This needs its own multilingual
  retrieval work; it is not evidence that French, Polish or Turkish answer
  generation is safe.

## Explanation results

Term-based coverage is a lower bound. It uses language-invariant terms
(`ETS`, `2026/895`, `50`, `38`, `60`) so the same label scores every language,
but a correct paraphrase without the literal term is scored as missing. The
manual read is one reviewer's check of the five reviewed facts (two climate,
three university).

| Language | Claims | Audit supported | Target language | Terms flagged | Term coverage | Citation support | Orphan abstention | Qualification |
| -------- | -----: | --------------: | --------------: | ------------: | ------------: | ---------------: | ----------------: | ------------: |
| English  |     32 |           31/32 |           28/32 |             4 |         0.833 |            0.833 |             1.000 |         1.000 |
| German   |     31 |           28/31 |           31/31 |             0 |         0.583 |            0.583 |             1.000 |         1.000 |
| French   |     31 |           30/31 |           21/31 |            10 |         0.500 |            0.500 |             1.000 |         1.000 |
| Polish   |     31 |           29/31 |           26/31 |             4 |         0.333 |            0.333 |             1.000 |         1.000 |
| Turkish  |     31 |           30/31 |           26/31 |             5 |         0.000 |            0.000 |             1.000 |         1.000 |

The automated audit supported 30 of 31 French claims; manual review found one
additional unsupported claim on page 292037:2 (see [Claim audit](#claim-audit)),
so the effective French supported count is 29/31. The orphan-abstention column
tests the product's deterministic missing-parent branch with a localized
message; it does not test model abstention.

The mean term scores hide the per-case difference. The manual read of the five
fact questions is:

| Language | Climate: ESR scope | Climate: 2026/895 | University: 50 % | University: 38 % | University: 60 M € |    Fully stated |
| -------- | ------------------ | ----------------- | ---------------- | ---------------- | ------------------ | --------------: |
| English  | yes                | yes               | yes              | yes              | no                 |             4/5 |
| German   | yes                | yes               | yes              | no               | yes                |             4/5 |
| French   | partial            | no                | yes              | yes              | yes                | 3/5 + 1 partial |
| Polish   | yes                | partial           | yes              | yes              | no                 | 3/5 + 1 partial |
| Turkish  | partial            | partial           | no               | no               | no                 | 0/5 + 2 partial |

The gap between the two tables is the main measurement caveat:

- German states the ESR scope as "außerhalb des EU-Emissionshandels" and the
  decision as 2026/895 without the literal ETS token; the term score records
  one climate fact missing, the manual read records both.
- Polish states the ESR scope outside the EU emissions trading system but calls
  the decision only "the 2026 executive decision", so one climate fact is
  partial.
- Turkish states national binding pathways for 2021–2030 and allocation
  quantities for 2026–2030 without the ETS scope or the decision number. Both
  climate facts are partial.
- Turkish university funding selected the 493 M € 2024–2030 programme and the
  planned DAFG instead of the asked 50 %, 38 % and 60 M € facts. The claims are
  supported by page 1–2, but they do not answer the question. This is a
  synthesis/fact-selection failure, not a citation failure.

Citation support equals coverage on these five facts because every covered
claim cited one of the reviewed pages. The deterministic quote check removed no
claim from the audited set: every surviving claim's quote occurred in its cited
source.

### Qualification and abstention

All five languages produced `partial` for the truck-toll question and named the
missing 2025 amount:

- EN: "The stored evidence does not contain the requested facts: Amount
  received from the truck toll in 2025."
- DE: "Die gespeicherten Belege enthalten die gefragten Angaben nicht:
  Einnahmen der Autobahn GmbH aus der Lkw-Maut im Jahr 2025."
- FR: "Les éléments stockés ne contiennent pas les faits demandés : Montant
  reçu par l'Autobahn GmbH du péage poids lourds en 2025."
- PL: "Zgromadzone dowody nie zawierają wymaganych informacji: Ile otrzymała
  Autobahn GmbH z opłat za przejazd ciężarówek w 2025 roku."
- TR: "Saklanan kanıtlar istenen bilgileri içermemektedir: Autobahn GmbH'nin 2025
  yılında kamyon geçiş ücretinden aldığı miktar."

All five abstained on the orphan lunar timeline and returned a localized
statement that the proceeding record is missing. No language invented a rule on
lunar minerals. This is the clearest positive result for the localization of the
deterministic abstention path. It does not test whether the model would abstain
on a non-orphan dossier with insufficient evidence; that still needs a separate
case.

### Claim audit

The audit flagged seven distinct claims. Four of those are material (two German
climate step claims, the English truck-toll budget claim and the French page-3
tax-revenue claim); three are audit false positives, mostly "future date" errors
from the audit model's own date. Manual review found one further material error
the audit missed: the French page-2 claim treats 4 996,94 M € as additional tax
revenue, but page 292037:2 shows it is the toll share (`Mautanteil`), with VAT
revenue 13,29 M €.

| Case / language | Claim (short)                                                       | Evidence           | Verdict                                                                                                                                         |
| --------------- | ------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Climate / DE    | "Zahlenmäßige Übersicht zu Deutschlands Emissionen 2021-2025 …" (2) | step 698621/698672 | Unsupported as cited: the step fields do not state the emission years; the page does. Attribution error, facts themselves are on page 290322:1. |
| Truck toll / EN | Federal budget "decreased revenue" from Lkw-Maut and VAT deductions | page 292037:3      | Over-broad: the source shows a reallocation of toll revenue and estimated revenue losses, not one overall revenue decrease.                     |
| Truck toll / FR | "recettes fiscales totales … 100 millions"                          | page 292037:3      | Audit flagged; imprecise: 100 M € is `Ertragssteueraufkommen`, not total tax revenue. Figures themselves match the page.                        |
| Truck toll / FR | 4 996,94 M € described as additional tax revenue                    | page 292037:2      | Manual finding; audit false negative: it is the toll share (`Mautanteil`), not additional tax revenue; VAT revenue is 13,29 M €.                |
| Truck toll / TR | "milyonlarca Euro gelir kaybı" (millions in revenue loss)           | page 292037:3      | Audit false positive: "millions" is a correct rounding of 1 505/1 454/1 369 M €.                                                                |
| Housing / DE    | Written answer given on 7 October 2026                              | step 701230        | Audit false positive: 7 October 2026 is the stored step date and the run date is 16 November 2026.                                              |
| University / PL | Answer given on 3 November 2026                                     | step 702970        | Audit false positive: same date error; the step is stored with that date.                                                                       |

Two more audit results are recorded rather than treated as fact errors. The
audit attached terminology issues to several step claims that are otherwise
faithful translations (for example French "notification" for `Unterrichtung`);
those are language issues, not invented facts. The French university claim that
combines the 50 %, 38 % and 60 M € facts was not flagged in the final run;
manual review finds it supported by page 291815:1.

### Language and terminology failures

The documents sections were consistently in the target language. The failures
are concentrated in step claims, where the generator copies German step labels
and the shared verifier accepts them:

- **French climate:** the stage claim and all four step claims are German with
  French connectives: "Mitteilung au Bundestag …", "Unterrichtung au Bundesrat …",
  "Überweisung au Bundestag …". Ten of 31 French claims fail the target-language
  check, and ten claims carry an untranslated German procedural term.
- **French truck toll:** the timeline is "Gesetzentwurf im Bundesrat am 9
  octobre 2026", "Empfehlungen der Ausschüsse am 6 novembre 2026" and "1.
  Beratung im Bundestag am 6 novembre 2026".
- **Polish truck toll:** "Gesetzentwurf został przedstawiony w Bundesrat.",
  "Ausschüsse Bundesratu przedstawiły swoje rekomendacje dotyczące
  Gesetzentwurf." The Polish grammar is right; the procedural nouns are German.
- **Turkish truck toll:** the full German law title and "1. Beratung" are kept
  in a Turkish sentence.
- **English truck toll, the baseline:** four step claims are entirely German
  ("Gesetzentwurf …", "Empfehlungen der Ausschüsse …", "Erste Beratung …").
  English language adherence is 28/32 for the same reason. This is not an
  additional-language-only defect; it is a shared verifier and step-assembly
  defect that becomes more visible when the target language is not English or
  German.
- French and Polish university outputs correctly translate `Kleine Anfrage` as
  "petite question parlementaire"/"małe zapytanie" and keep `HAW` as an
  official abbreviation. Those are acceptable; the report does not treat every
  German name as a translation failure.
- Turkish uses "havale" for `Überweisung`. A fluent reviewer should confirm
  whether that is the preferred parliamentary term; the audit did not flag it,
  so this remains an open terminology question rather than a confirmed error.

## Representative outputs

French climate, documents section (target language) versus timeline (German):

> L'aperçu des dépassements ou des sous-dépassements des allocations annuelles
> d'émissions pour l'Allemagne selon le règlement européen sur la protection du
> climat montre des variations en milliers de tonnes de CO2 équivalent de 2021
> à 2025.
>
> Mitteilung au Bundestag concernant les directives d'exécution du règlement
> européen sur la protection du climat. (step 701498)
>
> Unterrichtung au Bundesrat concernant les directives d'exécution du règlement
> européen sur la protection du climat. (step 698672)

French university, one page claim carrying all three reviewed facts:

> Environ 50 % de toutes les universités en Allemagne étaient des universités
> de sciences appliquées (HAW) au semestre d'hiver 2024/2025, représentant
> environ 38 % de tous les étudiants, et le gouvernement fédéral a alloué au
> moins 60 millions d'euros par an pour la recherche appliquée dans ces
> universités de 2019 à 2023, avec un financement supplémentaire prévu jusqu'en 2030. (page 291815:1)

Polish truck toll, German procedural nouns inside Polish sentences:

> Gesetzentwurf został przedstawiony w Bundesrat.
>
> Ausschüsse Bundesratu przedstawiły swoje rekomendacje dotyczące
> Gesetzentwurf.
>
> Zgromadzone dowody nie zawierają wymaganych informacji: Ile otrzymała
> Autobahn GmbH z opłat za przejazd ciężarówek w 2025 roku.

Turkish university, supported facts that do not answer the question:

> 2024-2030 döneminde, Bund-Länder-Vereinbarung kararı ile, toplamda yaklaşık
> 493 milyon Euro proje desteği sağlanacaktır. (page 291815:1)
>
> Alman hükümeti, uygulamaya yönelik araştırma ve yeniliği kalıcı olarak
> güçlendirmek amacıyla bir Alman Uygulamalı Araştırma Topluluğu (DAFG) kurmayı
> planlıyor … (page 291815:2)

English truck toll, the baseline leak:

> Gesetzentwurf zur Änderung der Finanzierung der Infrastrukturgesellschaft
> für Autobahnen und andere Bundesfernstraßen im Bundesrat eingebracht.
> (step 701438)

## Latency and cost

The English and German controls returned in 0.3–2.1 s, consistent with cached
briefs, so their mean latency is not a cold generation measurement and is not
comparable. The French, Polish and Turkish prototype path is cold. These means
cover the four generated answers and exclude the deterministic 0 ms lunar
abstention:

| Language | Mean generated-answer latency | Range      |
| -------- | ----------------------------: | ---------- |
| French   |                        13.4 s | 6.2–17.7 s |
| Polish   |                        11.5 s | 5.7–17.5 s |
| Turkish  |                        12.9 s | 4.7–21.9 s |

The candidate path made 12 generation calls, 11 verification calls, 10 term
calls and 9 page-translation calls. It used about 82,200 input and 12,300
output tokens. At OpenAI list prices of $2.50 per million input and $10 per
million output tokens, that is about **$0.33 for 12 answers, or $0.027 per
answer** before audit. The `gpt-4o-mini` audit used 141,100 input and 4,100
output tokens for 156 claims, about **$0.024 for the run**. Query translation
added about $0.006. The whole run cost roughly **$0.36**, or **$0.03 per
candidate answer** including audit. Per 1,000 answers, budget about $30 plus
whatever human review is required.

These are list-price estimates, not invoices, and they exclude the human review
that the existing citation code already requires before auto-publishing.

## Limitations

- One run of a nondeterministic model on five topic-selected cases. It is a
  diagnostic, not an estimate of production quality.
- Term-based coverage is a lower bound; the manual fact table is one reviewer's
  read. The two should be read together.
- The French/Polish/Turkish assembly is a prototype. The fixed qualification,
  orphan and fallback sentences are localized in the spike, not in the product.
- The English/German controls were partly cached; candidate latency and cost
  are the cold path. Candidate calls used `temperature: 0`; the English/German
  controls used the product provider's default. The JSON `cold` field is a
  1.5 s latency label, not a cache probe; do not treat it as authoritative.
- The audit model is noisy. Its language flag is replaced by the deterministic
  target-language check, and its "future date" findings are manual false
  positives. The audit is a screening pass, not a publication gate.
- The deterministic target-language check is a German-marker/target-marker
  heuristic, not a language detector. It catches copied German and missing
  target markers; it does not prove fluency. The language-adherence numbers are
  a screening signal, not a linguistic review.
- The corpus is live. Do not compare coverage across different corpus
  snapshots; use the per-case versions and document hashes in the JSON. The
  JSON records five post-run corrections: the stale expected page, per-case
  corpus provenance, full prompt hashes, the corrected language/term recount
  and the generated-answer latency mean.
- Retrieval used the current embedding index without tuning. The French and
  Polish misses may move with query translation or retrieval work.

## Recommendation

No production language option or product code change is made by this spike. The
four prompts are copied verbatim into the spike script so it can reuse the
production wording without touching `src/dip/explain/provider.ts`; full hashes
are in the JSON. Production work is tracked in
[#124](https://github.com/rotimi-babalola/news-intelligenz/issues/124).

| Language | Pilot decision       | Why                                                                                                                                                                                                                                                          |
| -------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| French   | No-go now; prototype | Strongest fact coverage (all three university facts) and correct qualification/abstention. Blockers: one timeline wholly German, ten untranslated procedural terms, housing retrieval miss. Re-test after shared fixes.                                      |
| Polish   | No-go now; prototype | Fact coverage close to German and better language adherence than French. Blockers: climate retrieval miss, German procedural nouns in the truck-toll timeline. Re-test after shared fixes.                                                                   |
| Turkish  | No-go                | Weakest fact selection: the university answer chose the 493 M € programme instead of the asked 50/38/60 facts; term coverage zero; the lunar record was not in the top 5. Do not pilot until fact-selection controls and a Turkish terminology review exist. |

Shared fixes required before any second prototype or pilot:

1. **Name the target language in the verifier prompt and add a deterministic
   language check.** The current verifier accepted untranslated German step
   claims in French, Polish, Turkish and English. Reject a claim that is not in
   the target language even when its quote is exact.
2. **Build step claims from stored `stepLabel`/`title` fields and translate
   them.** Do not trust a generated step claim that repeats the German label.
   This closes the timeline leak and benefits English too.
3. **Translate the query or add multilingual retrieval, and measure top-1 and
   top-5 proceeding recall plus expected-evidence recall per language.** French
   housing and Polish climate were retrieval failures; the Turkish lunar record
   was not in the top 5. Generation from a forced dossier was not the problem.
4. **Localize every fixed string** (qualification, orphan, fallback timeline)
   in the product, and add a reviewed parliamentary glossary per language
   (`Gesetzentwurf`, `Drucksache`, `Ausschüsse`, `Beratung`, `Überweisung`,
   `Mitteilung`, `Unterrichtung`, `Mündliche Frage`, `Schriftliche Antwort`).
5. **Keep language-specific brief caches** and never reuse an English or
   German brief for a new language.
6. **Add per-language reviewed labels and a control run** on the same corpus
   snapshot. The existing English/German label file is the model; do not compare
   across snapshots or models.

Quality checks required before adding a language:

- Every factual claim has an exact quote and a valid step/page citation; a
  fluent reviewer spot-checks all claims in the pilot set.
- No untranslated German procedural term appears in a non-German timeline;
  organisation and legal instrument names may stay in official form.
- Abstention and qualification match the English/German behaviour on the
  reviewed cases.
- Retrieval top-5 proceeding recall and expected-evidence recall meet or beat
  the English/German baseline on the same questions; no top-1 regression on the
  abstention case.
- A fluent speaker signs off the glossary, grammar and readability.
- Cost and latency stay within the product budget; the prototype was about
  $0.03 and 13 s per generated answer before human review.

## Reproduce

```sh
pnpm spike:explain-languages
```

The command writes
`docs/evaluation/multilingual-spike-2026-11-16/run.json`.
Re-running makes new model calls, so it produces another sample and overwrites
this artifact; use `--out <path>` to keep a separate run. Labels are in
`fixtures/dip/explain-multilingual-spike.json`; the prototype is
`scripts/spike-explain-languages.ts`. The labels were rechecked against the
current corpus on 2026-11-16. The climate label's page 290340:4 is expected but
is not retrieved by any language; that is recorded rather than hidden.
