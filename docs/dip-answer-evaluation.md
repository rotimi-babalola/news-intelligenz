# DIP answer evaluation

Retrieval evaluation measures whether the right evidence is found. This
evaluation measures whether the explainer answers the question from that
evidence, cites a reviewed source, and abstains when the corpus cannot answer.
The two reports share queries and proceedings but keep their scores separate.

## Reviewed labels

Each case names a real question, its language, the expected proceeding, and
either expected facts or an abstention expectation:

```json
{
  "reviewed": true,
  "cases": [
    {
      "question": "How are Germany's emissions allocations for 2021 to 2030 accounted for?",
      "language": "en",
      "proceeding": "338509",
      "facts": [
        {
          "text": "Implementing decision 2026/895 sets the ESR allocation quantities for 2021 to 2030.",
          "terms": ["allocations", "2021", "2030"],
          "evidenceIds": ["page:290322:3", "page:290340:3"],
          "quote": "Damit wurden die ESR-Zuweisungsmengen (AEA) für jeden Mitgliedstaat für die Jahre 2021 bis 2030 festgelegt."
        }
      ]
    },
    {
      "question": "What rules does the law on taxing lunar minerals set for space mining?",
      "language": "en",
      "expectAbstain": true
    }
  ]
}
```

- `terms` are language-specific strings that must all occur in one claim's
  text. They make coverage deterministic without asking a model to judge the
  answer. The expected `text` stays readable in the report.
- `evidenceIds` are the reviewed supporting step or PDF page. Use
  `step:<vorgangsposition id>` or `page:<document reference id>:<page>`.
  Include every stored source that supports the fact so a correct answer is not
  punished for citing a second valid page.
- `quote` is an exact source passage from one of the listed sources. It makes
  the label auditable; the generator already rejects claims whose quote is
  absent from the cited evidence.
- An abstention case has no expected facts. If it names a `proceeding`, the
  evaluator uses that dossier, so the case measures insufficient evidence for a
  real record. If it omits `proceeding`, the evaluator uses the top retrieved
  dossier, the answer a reader would see.
- Set `reviewed` to `true` only after checking every ID, page and quote against
  the evaluated branch. Use real records from the same corpus snapshot for both
  languages.

The reviewed set at
[`fixtures/dip/explain-eval.reviewed.json`](../fixtures/dip/explain-eval.reviewed.json)
covers climate allocations, university funding, motorway financing, grid
charges, the 2045 grid-charge forecast, housing costs and two
insufficient-evidence
questions in English and German.

## Metrics

For each expected fact:

- **Covered** when one claim's text contains every `term`.
- **Cited** when a covering claim cites one of `evidenceIds`.

Coverage ignores a correct quote attached to an answer that says nothing about
the fact. Citation support separately requires the answer to attribute the fact
to a reviewed source. The generator's quote and verifier checks remain the
first line of citation defence; this report measures the surviving claims.

Per language, the evaluator reports:

| Metric               | Meaning                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `factualCoverage`    | Mean share of expected facts stated, across cases with expected facts |
| `citationSupport`    | Mean share of expected facts stated with a reviewed citation          |
| `abstentionAccuracy` | Share of abstention cases whose `answerConfidence` is `abstain`       |
| `answerRate`         | Share of answerable cases that produced a non-abstaining answer       |
| `coveredFacts`       | Raw covered count out of raw expected facts, for small samples        |

Each case also records the answer and the corpus snapshot: proceeding and step
version numbers plus document byte hashes. The report header records the
explainer base URL, model and prompt/adapter identity hash.

Failures carry the language, question, answer, expected fact or abstention and
one cause:

- `retrieval` — none of the expected evidence reached the dossier.
- `dossier` — the evidence was retrieved but did not reach the explainer, or
  the selected dossier has no parent proceeding.
- `synthesis` — the evidence reached the model but the answer omitted the fact
  or attributed it to another source.

## Run

Use the same fixed branch and explainer configuration as the answers being
reviewed:

```sh
pnpm evaluate:explain -- fixtures/dip/explain-eval.reviewed.json
```

The command writes JSON to stdout, including per-case answers and failures.
Cached briefs are reused when the question, language, corpus versions, document
bytes and provider identity are unchanged, so re-scoring a reviewed label file
does not call the provider again. A changed model, prompt or source version
produces a new answer and a new cache key.

Treat the result as a diagnostic on this small topic-selected set, not as an
estimate of production answer quality. Do not compare coverage across different
corpus snapshots or explainer configurations.
