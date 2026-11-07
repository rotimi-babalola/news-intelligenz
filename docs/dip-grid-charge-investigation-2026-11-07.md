# 2045 grid-charge retrieval investigation, 7 November 2026

## Reproduction

Ran `pnpm evaluate:dip -- fixtures/dip/embedding-eval.reviewed.json` against
the configured production Neon branch after PDF page deduplication. The index
remained `openai:text-embedding-3-small:9e33b9fd2b34`; this investigation did
not collect records, change ranking, or write embeddings. The 16-query mean
recall@5 was 0.742, recall@10 was 0.754, MRR@10 was 0.875, and mean latency
was 2,169 ms (median 1,074 ms). The first query took 17,773 ms. Both 2045
grid-charge queries still had recall@10 of zero; neither labeled item was in
the top 100. Their top-10 latencies were 1,031 ms German and 1,069 ms English.
The other 14 queries retained their top-10 evidence IDs and recall@10 values
from the [page-deduplication evaluation](dip-embedding-dedup-eval-2026-11-07.md).

## Cause

Both [proceeding 340178](https://search.dip.bundestag.de/api/v1/vorgang/340178)
and [step 701442](https://search.dip.bundestag.de/api/v1/vorgangsposition/701442)
have current version **2**, observed at 06:02:31 and 06:02:35 UTC respectively.
Their current titles are both “Entwicklung der Netzentgelte für Strom bis zum
Jahr 2045”; the step label is “Schriftliche Frage/Schriftliche Antwort”. The
configured index contains only version **1** vectors for these IDs. Both
version 2 embedding jobs are pending with zero attempts. Thus the search's
current-version joins exclude both vectors, regardless of similarity score.

| Query                        | Current rank, each target | Version 1 proceeding score | Version 1 step score | Live first score |
| ---------------------------- | ------------------------: | -------------------------: | -------------------: | ---------------: |
| German, through 2045         |           Outside top 100 |                     0.8860 |               0.7960 |           0.6785 |
| English, future grid charges |           Outside top 100 |                     0.5449 |               0.5657 |           0.5452 |

The version 1 proceeding and step would both outrank the German first result;
the version 1 step would outrank the English first result. These are diagnostic
scores for historical vectors, not valid current-version search results. The
retrieval miss is therefore an index freshness gap. No ranking change is
justified by this run. Keep the current-version filter and source references.
The linked PDF 21/8312 remains a separate extraction gap.

After the pending version 2 embeddings are processed as separate index work,
rerun the same reviewed queries and compare both target ranks and the other
14 cases before considering ranking changes.
