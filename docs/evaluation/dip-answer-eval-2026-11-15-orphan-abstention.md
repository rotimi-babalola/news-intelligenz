# Orphan dossier abstention, 15 November 2026

Issue [#109](https://github.com/rotimi-babalola/news-intelligenz/issues/109)
followed the [15 November answer evaluation](dip-answer-eval-2026-11-15.md),
where both lunar-mineral questions summarised dossier `325604` even though that
dossier has no parent proceeding record. `generateProceedingBrief` now returns
an abstaining brief, with no claims and no provider call, whenever
`dossier.parentMissing` is true.

## Re-run

`pnpm evaluate:explain -- fixtures/dip/explain-eval.reviewed.json` completed at
2026-11-16T02:49Z on the reviewed labels. The explainer configuration was OpenAI
`gpt-4o` at `https://api.openai.com/v1`, adapter identity
`3daccf6afa14741cf77b156df220d2e7a8bf7b912f2a3b54426b0394c9f36fd2`. Retrieval
still returned the same orphan dossier, so the change is a dossier rule, not a
retrieval effect. The [full evaluator output](dip-answer-eval-2026-11-15-orphan-abstention.json)
retains every answer and score.

| Language | Question                      | Proceeding | Parent missing | Confidence | Claims | Correct abstention |
| -------- | ----------------------------- | ---------: | -------------- | ---------- | -----: | -----------------: |
| DE       | Mondmineralien / Weltraum     |     325604 | yes            | abstain    |      0 |                yes |
| EN       | Lunar minerals / space mining |     325604 | yes            | abstain    |      0 |                yes |

Both abstentions say the proceeding record is missing, and neither calls the
provider or caches a brief. Abstention accuracy was **1.000 (2/2)** for the
orphan-dossier cases, up from 0.000 (0/2). The twelve answerable cases still
produced answers (`answerRate` 1.000) and both truck-toll fact-absent cases
still returned the requested qualification, so the parent-proceeding path is
unchanged.

The other cases were regenerated under this branch's provider identity, which
differs from the [15 November report](dip-answer-eval-2026-11-15.md); their
coverage and citation scores are not comparable with that run. This report
records only the orphan-dossier abstention result.
