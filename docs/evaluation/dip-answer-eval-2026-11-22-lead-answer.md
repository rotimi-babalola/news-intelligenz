# Question-facing lead answer evaluation, 22 November 2026

## Reproduce

Run `pnpm evaluate:explain -- fixtures/dip/explain-eval.reviewed.json` against
the branch and explainer configuration being compared. This report pairs the
[lead-answer run](dip-answer-eval-2026-11-22-lead-answer.json) with a
[control run](dip-answer-eval-2026-11-22-lead-answer-control.json) of the
unchanged claim assembly on the same corpus snapshot and model. No collection,
reindexing or retrieval tuning was made for either run.

Both runs finished on 2026-11-22. At report time the branch held 4,281
proceedings, 34,554 steps, 12,708 current fetched documents, 239,792 extracted
pages (719,115 passages) and 299,064 embeddings; the latest proceeding and step
observations were 21 November 06:02Z. The branch is not an immutable snapshot,
so the per-case corpus record in each JSON is the authoritative version and
document-byte record.

The corpus has grown substantially since the 16 November report, which held
3,914 proceedings, 34,045 steps, 746 current documents, 57,645 passages and
85,394 embeddings. The reviewed label set also grew from 16 cases and 24 facts
to 18 cases and 32 facts when #125 added the step 703914 cases. Document
retrieval therefore reached different pages and the labelled denominator
changed, so the unchanged branch scores below that report on this corpus
(0.310 coverage and citation support against 0.542 and 0.500). The same-corpus
control is the correct comparison for this change; the literal numbers are not
comparable to the 16 November snapshot.

Explainer configuration for both runs: OpenAI `gpt-4o` at
`https://api.openai.com/v1`. Adapter identity was
`4c78bb7d…c54b5c6d` for the control and `dbf599ca…31bf9c` for the lead-answer
run. The identity covers the base URL, model and prompts; the lead identity
includes the new selection prompt.

## What changed

- The claim model gains an `answer` section, ordered first. The generator
  produces one or two claims that directly answer the question asked.
- The answer prompt asks the generator to state the part of the question the
  evidence answers, to repeat the supporting claim from `matter`, `stage` or
  `documents`, and to leave `answer` empty only when no supplied evidence
  addresses the question.
- When the generated lead is empty, the explainer makes one further call that
  selects at most two of that language's already-verified `matter`, `stage` or
  `documents` claims by id. The text, quote and citation are copied, never
  rewritten. This removes the language asymmetry where one language's lead was
  rejected and the other language's survived.
- Citation validation resolves a bare DIP step id (for example `704437`) to the
  supplied `step:704437` evidence. It also accepts `missing` entries as either
  strings or claim-shaped objects; the English generator returned the latter,
  which previously discarded the whole missing list and lost the qualification.
- The reader answer maps `answer` claims first in its short answer, drops a
  lead claim repeated in `matter` or `stage`, and falls back to those sections
  when no lead claim survives. The operator brief tester shows the new group.
- Answer confidence still counts the five original claim categories, so a
  complete brief whose lead did not survive remains `supported` rather than
  gaining a spurious limitation.
- `BRIEF_ASSEMBLY_VERSION` moves to 16, so briefs built by an earlier assembly
  are not reused. The lead-answer run's adapter identity is also new, so its
  answers were generated cold.

## Results

Control is the unchanged branch; lead is this branch. Both use the same 18
reviewed cases, corpus, search limit and model.

| Group   | Run     | Facts | Coverage | Citation support | Abstention accuracy | Qualification accuracy |   Answer rate |
| ------- | ------- | ----: | -------: | ---------------: | ------------------: | ---------------------: | ------------: |
| All     | control |    32 |    0.310 |            0.310 |         1.000 (2/2) |            1.000 (2/2) | 0.857 (12/14) |
| All     | lead    |    32 |    0.476 |            0.369 |         1.000 (2/2) |            1.000 (2/2) | 0.857 (12/14) |
| English | control |    16 |    0.143 |            0.143 |         1.000 (1/1) |            1.000 (1/1) |   0.714 (5/7) |
| English | lead    |    16 |    0.405 |            0.262 |         1.000 (1/1) |            1.000 (1/1) |   0.714 (5/7) |
| German  | control |    16 |    0.476 |            0.476 |         1.000 (1/1) |            1.000 (1/1) |   1.000 (7/7) |
| German  | lead    |    16 |    0.548 |            0.476 |         1.000 (1/1) |            1.000 (1/1) |   1.000 (7/7) |

Coverage and citation support rise on this corpus; abstention, qualification
and answer rate are unchanged. Covered facts rise from 7 to 12 and cited facts
from 7 to 9. Synthesis failures fall from 15 to 13. The 10 retrieval failures
and the two retrieval-caused abstention misses are identical in both runs, so
the change adds synthesis coverage without changing retrieval.

| Topic / language         | Proceeding | Control covered | Lead covered |
| ------------------------ | ---------: | --------------: | -----------: |
| Climate allocations / DE |     338509 |             1/2 |          2/2 |
| Climate allocations / EN |     338509 |             0/2 |          1/2 |
| University funding / DE  |     340641 |             1/3 |          1/3 |
| University funding / EN  |     340641 |             0/3 |          1/3 |
| Motorway financing / DE  |     340174 |             1/2 |          1/2 |
| Motorway financing / EN  |     340174 |             0/2 |          0/2 |
| Grid charges 2029 / DE   |     339848 |             0/2 |          0/2 |
| Grid charges 2029 / EN   |     339848 |             0/2 |          0/2 |
| Grid charges 2045 / DE   |     340178 |             1/1 |          1/1 |
| Grid charges 2045 / EN   |     340178 |             1/1 |          1/1 |
| Housing costs / DE       |     339930 |             2/2 |          2/2 |
| Housing costs / EN       |     339930 |             0/2 |          2/2 |
| Tax-ID bank details / DE |     341626 |             0/4 |          0/4 |
| Tax-ID bank details / EN |     341626 |             0/4 |          0/4 |
| Truck toll 2025 / DE     |     340174 |             0/0 |          0/0 |
| Truck toll 2025 / EN     |     340174 |             0/0 |          0/0 |
| Lunar minerals / DE      |     325604 |             0/0 |          0/0 |
| Lunar minerals / EN      |     325604 |             0/0 |          0/0 |

## Lead claims

A lead claim was present in 9 of the 14 answerable cases, either generated or
selected from a verified claim. Each cites a stored step or page:

- **Climate allocations / DE (338509):** "Die tatsächlichen Emissionsdaten zur
  Bestimmung von Über- oder Unterschreitungen der Jahresziele der ESR werden
  nachträglich bestätigt, der Durchführungsbeschluss 2026/895 legt die
  Zuweisungsmengen von 2021 bis 2030 fest, und für 2013 bis 2020 gab es bereits
  verbindliche Zielpfade unter der EU-Lastenteilungsentscheidung (ESD)."
- **University funding / EN (340641):** "At least 60 million euros annually was
  allocated for applied research at universities of applied sciences (HAW)
  from 2019 to 2023." followed by the 61-million-euro Special Assets figure.
- **Motorway financing / EN (340174):** the three-pillar funding model, followed
  by the limited-credit and direct truck-toll revenue changes.
- **Grid charges 2029 / DE (339848):** the proposed Grund- and Arbeitspreis
  changes and the Prosumer rules.
- **Grid charges 2045 / DE (340178):** "Eine belastbare Prognose zur Entwicklung
  der Stromnetzentgelte bis 2045 liegt nicht vor."

The lead is absent in the two housing-cost cases and the German tax-ID case
because no verified claim answers those questions, and in both truck-toll
cases because the requested 2025 value is absent; the qualification names it.
The two abstention cases carry no lead claim. When the lead is absent, the
reader answer still opens with `matter` and `stage`.

## Language symmetry spot checks

The lead used to appear in one language and not the other. These pairs are not
in the reviewed label set; they reproduce the reported asymmetry and check the
selector.

- **Stage question on 338850, German and English.** The long "What is the
  current stage of …" question now produces a lead in both languages. German:
  "20.11.2026 · Letzter dokumentierter Schritt: 2. Durchgang" and the protocol's
  purpose from page 1. English: "20 Nov 2026 · Latest documented step: Second
  Reading" and the protocol's purpose.
- **"2027 Haushalt" on 338366, German and English.** German leads with the
  draft law's tax, finance and Climate and Transformation Fund changes.
  English leads with "The current stage of the 2027 budget is the discussion and
  amendment phase with committee recommendations in progress."
- **Stage and matter questions on 340174, German and English.** German stage
  leads with "Der erste Durchgang im Bundesrat fand am 20. November 2026 statt."
  and German matter with "Das Verfahren behandelt die Änderung der Finanzierung
  der Infrastrukturgesellschaft …". English stage leads with "20 Nov 2026 ·
  Latest documented step: Decision Document" and English matter with the Act's
  title and the direct truck-toll revenue changes.

All six now lead in both languages. The selector copies a verified claim, so a
selected lead is as cited as the claim it came from.

## Remaining misses

All 13 synthesis failures are facts the retrieved evidence contains but the
answer did not state or attributed to another page. Against the control, the
lead run gains the German and English climate 2026/895 facts, the English
60-million figure, and both English housing-cost facts; no reviewed fact is
lost. Synthesis failures fall from 15 to 13 because two of the gains are
covered without a reviewed citation.

The 10 retrieval failures are unchanged: the English grid-charge 2029 and
tax-ID bank-detail questions do not retrieve their reviewed proceeding, so both
answerable English cases are capped at an abstention in both runs. Both
qualification cases name the missing 2025 figure, including the English case
whose missing facts arrive as claim-shaped objects. Both abstention cases
remain correct.

## Limitations

Coverage is term-based and one run is a sample of a nondeterministic model.
The selector runs only when the generated lead is empty and adds one provider
call in those cases. Alternate wording, units and pages still cost coverage,
and the small topic-selected set makes the aggregate diagnostic rather than an
estimate of production quality. The corpus is not the 16 November snapshot, so
the same-corpus control is the applicable comparison. New lead claims in this
run were not individually reviewed by a human; the generator quote check, the
model verifier and the selector's copy-only rule are the citation defence.
