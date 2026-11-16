# DIP page deduplication evaluation, 7 November 2026

Re-ran the same 16 [reviewed German and English queries](../../fixtures/dip/embedding-eval.reviewed.json)
with `pnpm evaluate:dip -- fixtures/dip/embedding-eval.reviewed.json` after
ranking only the highest-scoring passage per document reference and page. The
[complete results](dip-embedding-dedup-eval-2026-11-07.json) include the 160
ranked evidence units and query latencies. The embedding index ID was unchanged:
`openai:text-embedding-3-small:9e33b9fd2b34`. No re-embedding was performed.

| Metric                                      | [Before](dip-embedding-eval-2026-11-07.md) |    After |
| ------------------------------------------- | -----------------------------------------: | -------: |
| Repeated PDF page slots across top-10 lists |                                         15 |        0 |
| Lists with repeated PDF pages               |                                    8 of 16 |  0 of 16 |
| Mean recall@5                               |                                      0.704 |    0.742 |
| Mean recall@10                              |                                      0.754 |    0.754 |
| MRR@10                                      |                                      0.875 |    0.875 |
| Mean latency                                |                                   2,424 ms | 2,297 ms |
| Median latency                              |                                   1,231 ms | 1,178 ms |

Both applied-sciences queries improved to recall@5 of 1.000 (from 0.600 German
and 0.800 English). The other 14 recall@5 values, all 16 recall@10 values, and
all first-ranked evidence units stayed the same. The separate 2045 grid-charge
item remains absent from both top-10 lists.

Latency is one run before and one run after, including cold first queries of
19,441 ms and 18,112 ms. It is an observed comparison, not evidence that the
query became faster. This run did not verify that the live corpus stayed fixed
between evaluations.
