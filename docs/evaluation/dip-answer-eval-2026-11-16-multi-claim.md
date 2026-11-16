# Multi-claim page evaluation, 16 November 2026

## Reproduce

Run `pnpm evaluate:explain -- fixtures/dip/explain-eval.reviewed.json` against
the branch and explainer configuration being compared. This report pairs the
[multi-claim run](dip-answer-eval-2026-11-16-multi-claim.json) with a
[control run](dip-answer-eval-2026-11-16-multi-claim-control.json) of the
unchanged claim assembly on the same corpus snapshot and model. No collection,
reindexing or retrieval tuning was made for either run.

Both runs finished on 2026-11-16. The branch held 3,914 proceedings, 34,045
steps, 746 current fetched documents, 57,645 extracted passages and 85,394
embeddings; the latest proceeding and step observations were 14 November
06:02Z. The branch is not an immutable snapshot, so the per-case corpus record
in each JSON is the authoritative version and document-byte record.

Explainer configuration for both runs: OpenAI `gpt-4o` at
`https://api.openai.com/v1`. Adapter identity was
`3daccf6a…f36fd2` for the control and `cdd920c2…59521` for the multi-claim run.
The identity hash covers the base URL, model and all three prompts.

## What changed

- A cited page now reaches the generator as its stored page text, not only the
  single retrieved chunk, so facts elsewhere on the same page are visible.
- Document alignment keeps every validated claim for a page instead of
  overwriting all but the last one. A page only gets a translated fallback
  claim when no verified claim survives.
- The answer prompt asks for one claim per question-relevant fact on a page.

`BRIEF_CACHE_VERSION` moves to 12 so briefs built by the old assembly are not
reused.

## Results

Control is the unchanged branch; multi-claim is this branch.

| Group   | Run         | Facts | Coverage | Citation support | Abstention accuracy | Qualification accuracy |   Answer rate |
| ------- | ----------- | ----: | -------: | ---------------: | ------------------: | ---------------------: | ------------: |
| All     | control     |    24 |    0.403 |            0.403 |         1.000 (4/4) |            1.000 (2/2) | 1.000 (12/12) |
| All     | multi-claim |    24 |    0.542 |            0.500 |         1.000 (4/4) |            1.000 (2/2) | 1.000 (12/12) |
| English | control     |    12 |    0.389 |            0.389 |         1.000 (2/2) |            1.000 (1/1) |   1.000 (6/6) |
| English | multi-claim |    12 |    0.389 |            0.389 |         1.000 (2/2) |            1.000 (1/1) |   1.000 (6/6) |
| German  | control     |    12 |    0.417 |            0.417 |         1.000 (2/2) |            1.000 (1/1) |   1.000 (6/6) |
| German  | multi-claim |    12 |    0.694 |            0.611 |         1.000 (2/2) |            1.000 (1/1) |   1.000 (6/6) |

Abstention accuracy improved from the 15 November report because the
orphan-dossier abstention change landed; it is equal in both runs here and is
not attributable to this change.

| Topic / language         | Proceeding | Control covered | Multi-claim covered |
| ------------------------ | ---------: | --------------: | ------------------: |
| Climate allocations / DE |     338509 |             1/2 |                 1/2 |
| Climate allocations / EN |     338509 |             1/2 |                 0/2 |
| University funding / DE  |     340641 |             0/3 |                 2/3 |
| University funding / EN  |     340641 |             1/3 |                 1/3 |
| Motorway financing / DE  |     340174 |             0/2 |                 1/2 |
| Motorway financing / EN  |     340174 |             0/2 |                 0/2 |
| Grid charges 2029 / DE   |     339848 |             1/2 |                 1/2 |
| Grid charges 2029 / EN   |     339848 |             1/2 |                 1/2 |
| Grid charges 2045 / DE   |     340178 |             1/1 |                 1/1 |
| Grid charges 2045 / EN   |     340178 |             1/1 |                 1/1 |
| Housing costs / DE       |     339930 |             1/2 |                 2/2 |
| Housing costs / EN       |     339930 |             0/2 |                 1/2 |
| Truck toll 2025 / DE     |     340174 |             0/0 |                 0/0 |
| Truck toll 2025 / EN     |     340174 |             0/0 |                 0/0 |
| Lunar minerals / DE      |     325604 |             0/0 |                 0/0 |
| Lunar minerals / EN      |     325604 |             0/0 |                 0/0 |

Coverage rises on the university funding, housing costs and German motorway
cases. The German university-funding answer now states all three reviewed
facts from page 1 of Drucksache 21/8697, each with its own quote and the same
page citation.

## Remaining misses

All fact failures are still `synthesis` failures: the page was retrieved and
reached the explainer but the answer did not state the reviewed fact.

- **English climate (338509) is a term failure, not a missing fact.** The
  answer states the ESR framework as "binding national targets for greenhouse
  gas emission reductions outside the EU Emissions Trading System for 2021 to
  2030", and the 2026/895 decision as "allocation amounts". The reviewed terms
  are "pathways" and "allocations", so the fact-builder records it missing.
- **The German motorway answer (340174)** states the three-pillar fact and
  quotes it from page 11 of Drucksache 21/8868. The label lists only page 1 as
  supporting evidence, so citation support records the fact as uncited even
  though the quote is exact and from the same document.
- **The private-law company form (340174)** and the 30.1 percent equity return
  (339848) remain unstated in both languages. They are on the cited pages, but
  neither language's generator chose to include them.
- **The English university-funding answer** states the 50 percent and 38
  percent facts but omits the 60 million euro amount, so it covers one of three
  facts.

## Limitations

Coverage is term-based and one run is a sample of a nondeterministic model. The
control run is on the same corpus and model as the multi-claim run, but the 15
November report was a different corpus snapshot and a luckier sample; it is not
the right comparison. The multi-claim answers state more reviewed facts than
the control answers, but paraphrases and alternate pages still cost term-based
coverage. The repository is small and topic-selected, so the aggregate is
diagnostic rather than an estimate of production quality.
