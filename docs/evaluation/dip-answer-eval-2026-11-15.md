# DIP answer evaluation, 15 November 2026

## Reproduce

Run `pnpm evaluate:explain -- fixtures/dip/explain-eval.reviewed.json` against
the same fixed branch and explainer configuration. The
[reviewed labels](../../fixtures/dip/explain-eval.reviewed.json) cover six topics
with English and German questions plus two insufficient-evidence questions per
language.
The [full evaluator output](dip-answer-eval-2026-11-15.json) retains every
answer, expected fact, score and failure. No collection, reindexing, retrieval
tuning or explainer change was made for this evaluation.

The run finished at 2026-11-16T00:52Z. The branch held 3,914 proceedings,
34,045 steps, 730 current fetched documents, 32,518 extracted passages and
75,356 embeddings. The latest proceeding and step observations were 14 November
06:02–06:03Z, the latest PDF fetch 15 November 19:02Z, and the latest embedding
write 15 November 22:31Z. All of these predate the run. The branch is not an
immutable snapshot, so the per-case corpus record in the JSON is the
authoritative version and document-byte record.

Explainer configuration: OpenAI `gpt-4o` at `https://api.openai.com/v1`;
adapter identity
`acc4a89951ca5fd8f04557aee508a8b9ffeb57c85a6d0759d9aa27fa8c7a012e`. The
identity hash covers the base URL, model and all three prompts. Each case
records its proceeding version, step version numbers and cited document byte
hashes.

## Results

| Group      | Cases | Facts | Coverage | Citation support | Abstention accuracy |   Answer rate |
| ---------- | ----: | ----: | -------: | ---------------: | ------------------: | ------------: |
| All        |    16 |    24 |    0.639 |            0.639 |         0.000 (0/4) | 1.000 (12/12) |
| English    |     8 |    12 |    0.722 |            0.722 |         0.000 (0/2) |   1.000 (6/6) |
| German     |     8 |    12 |    0.556 |            0.556 |         0.000 (0/2) |   1.000 (6/6) |
| Answerable |    12 |    24 |    0.639 |            0.639 |                   — | 1.000 (12/12) |
| Abstention |     4 |     0 |        — |                — |         0.000 (0/4) |             — |

Coverage and citation support are equal in this run: every fact the answers
stated was attributed to a reviewed step or page. The gap is facts the answers
did not state, not wrong citations. Abstention accuracy counts only the four
abstention cases; answer rate counts only the twelve answerable cases, so
neither metric takes free wins from the other group.

| Topic / language         | Proceeding | Confidence | Covered | Cited | Correct abstention |
| ------------------------ | ---------: | ---------- | ------: | ----: | -----------------: |
| Climate allocations / DE |     338509 | partial    |     1/2 |     1 |                yes |
| Climate allocations / EN |     338509 | partial    |     1/2 |     1 |                yes |
| University funding / DE  |     340641 | partial    |     1/3 |     1 |                yes |
| University funding / EN  |     340641 | partial    |     1/3 |     1 |                yes |
| Motorway financing / DE  |     340174 | partial    |     1/2 |     1 |                yes |
| Motorway financing / EN  |     340174 | partial    |     2/2 |     2 |                yes |
| Truck toll 2025 / DE     |     340174 | partial    |     0/0 |     0 |                 no |
| Truck toll 2025 / EN     |     340174 | partial    |     0/0 |     0 |                 no |
| Grid charges 2029 / DE   |     339848 | partial    |     0/2 |     0 |                yes |
| Grid charges 2029 / EN   |     339848 | partial    |     1/2 |     1 |                yes |
| Grid charges 2045 / DE   |     340178 | partial    |     1/1 |     1 |                yes |
| Grid charges 2045 / EN   |     340178 | partial    |     1/1 |     1 |                yes |
| Housing costs / DE       |     339930 | partial    |     2/2 |     2 |                yes |
| Housing costs / EN       |     339930 | partial    |     2/2 |     2 |                yes |
| Lunar minerals / DE      |     325604 | partial    |     0/0 |     0 |                 no |
| Lunar minerals / EN      |     325604 | partial    |     0/0 |     0 |                 no |

## Failures and causes

All ten fact failures were **synthesis** failures: the expected step or page
was retrieved and reached the explainer, but the answer did not state the fact.
No answerable case failed at retrieval or dossier assembly. Two abstention
failures were **dossier** failures for an orphan dossier; the other two were
**synthesis** failures for a named proceeding whose stored pages lack the
requested year.

- **One page fact is not a page summary.** University funding retrieved and
  cited page 1 of [PDF 21/8697](https://dserver.bundestag.de/btd/21/086/2108697.pdf),
  but both languages state only the €60 million annual funding fact. Neither
  states that about half of German higher education institutions were HAW in
  winter semester 2024/2025 or that they teach about 38 percent of students.
  The page claim quotes a narrow funding passage even though the same page
  contains both scale facts. The same pattern costs the climate, grid-charge
  and German motorway cases one fact each.
- **German grid charges missed both expected facts.** The answer cites page 1
  of [PDF 21/8654](https://dserver.bundestag.de/btd/21/086/2108654.pdf) but says
  only that the new rules could include time- and location-differentiated
  charges. It omits the 1 January 2029 start and the 30.1 percent weighted
  equity return of the 18 largest distribution operators. English states the
  2029 start but also omits the 30.1 percent fact.
- **Climate answers omit the ESR framework.** Both languages state the
  2026/895 allocation decision but neither states that the ESR sets binding
  national greenhouse-gas pathways outside the EU emissions trading system for
  2021–2030.
- **German motorway answer omits the company form.** English states that the
  Autobahn GmbH is a private-law company; German does not. Both state the
  three-pillar financing model.
- **2045 grid charges answered from the linked page.** Both languages state
  that the government has no reliable forecast through 2045, citing page 48 of
  [PDF 21/8312](https://dserver.bundestag.de/btd/21/083/2108312.pdf). The step
  fallback alone would not have answered: its claim text is only "a proceeding
  step is documented", even though the step title names the 2045 forecast.
- **Named proceeding without the requested year still answers.** The truck-toll
  questions selected the correct dossier 340174, whose stored pages give 2028,
  2029 and 2030 revenue figures but no 2025 figure. Both languages returned
  `partial` with those later-year figures instead of saying the 2025 number is
  absent. This is a synthesis/answer-shape gap, not a retrieval gap: the right
  proceeding was found.
- **No abstention on an unanswerable question.** The lunar-mineral questions
  returned dossier 325604, which has seven steps but no parent proceeding
  record (`parentMissing` is true). The answers summarise that unrelated
  timeline with `answerConfidence: partial` instead of abstaining. Step and
  stage fallbacks always fill a timeline when steps exist, so a dossier with
  steps cannot reach `abstain` under the current policy.

Limitations: coverage is term-based, so a correct paraphrase that avoids the
reviewed terms would be scored as missing; reviewer terms were chosen from the
generated answers where the stored evidence was clearly covered. Abstention
accuracy rests on four cases, with two different insufficiency shapes. The
sample is small and topic-selected, so the aggregate is diagnostic rather than
an estimate of production quality. Citation support measures attribution to the
reviewed source; the generator's quote and verifier checks remain responsible
for whether a claim is entailed by that source.

## Next work

1. **Do not offer an explainer for an orphan dossier.** Reject or clearly
   qualify dossiers with `parentMissing` so the two orphan-dossier failures
   cannot present an unrelated timeline as an answer. This is a dossier rule,
   not a retrieval change.
2. **Let one page support more than one claim.** The university, climate, grid
   and motorway misses all come from pages that were retrieved and cited but
   summarised with one narrow claim. Re-run this label set after the change and
   keep the change only if it raises coverage without adding unsupported
   claims.
3. **Make the answer say when the requested fact is absent.** For a named
   proceeding whose pages cover a different period, the answer should state that
   the requested figure is not in the stored evidence, rather than returning a
   qualified timeline. This is separate from the off-topic-dossier relevance
   gate and would address both named-proceeding abstention failures.

The retrieval evaluation remains separate: this run did not measure recall or
MRR, and its answer scores must not be compared with retrieval scores.
