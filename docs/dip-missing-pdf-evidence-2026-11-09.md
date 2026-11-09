# Missing DIP PDF evidence, 9 November 2026

Issue [#72](https://github.com/rotimi-babalola/news-intelligenz/issues/72)
followed the [7 November evaluation](dip-embedding-eval-2026-11-07.md).
The configured production Neon branch and existing on-demand document jobs
processed the grid-charge reference and all four PDFs linked to climate
proceeding 338509. All five fetched, extracted, chunked, and embedded on the
existing `openai:text-embedding-3-small:9e33b9fd2b34` index. Each document
job succeeded on its first attempt; all 773 resulting embedding jobs succeeded.

| Reference | Document | Current content before → after |  Pages |  Chunks | Embeddings |
| --------- | -------- | -----------------------------: | -----: | ------: | ---------: |
| 291288    | 21/8312  |                          0 → 1 | 0 → 96 | 0 → 251 |    0 → 251 |
| 290322    | 21/7680  |                          0 → 1 |  0 → 4 |   0 → 8 |      0 → 8 |
| 290340    | 484/26   |                          0 → 1 |  0 → 5 |   0 → 7 |      0 → 7 |
| 290674    | 21/7984  |                          0 → 1 |  0 → 8 |  0 → 12 |     0 → 12 |
| 5818      | 21/100   |                          0 → 1 | 0 → 96 | 0 → 495 |    0 → 495 |

The corpus snapshot before processing had **410** current document contents,
**5,004** pages, **15,593** chunks, and **15,593** document embeddings. The
post-processing snapshot at **18:33:25 UTC** had **415**, **5,213**, **16,366**,
and **16,366**, respectively. These are live-branch observations, not an
immutable database snapshot.

The [reviewed labels](../fixtures/dip/embedding-eval.reviewed.json) now include
21/8312 PDF page 48: it contains the question about electricity grid charges
through 2045 and the government's answer that it has no reliable forecast.
For the climate queries, 21/7680 PDF pages 1–3 and 484/26 PDF pages 3–5
contain annual emissions-allocation figures and explanations. The other
linked PDFs were processed but not labeled: 21/7984 page 5 is a committee
referral, and 21/100 page 95 is a transcript notice; neither supplies the
allocation accounting requested by the queries. Page numbers refer to the
extracted PDF pages, not printed page numbers. Reference 291288 is shared by
many proceedings, so its on-demand metadata can name a different proceeding;
the PDF URL and page-48 text were checked against the target question.

## Evaluation after processing

After recording that snapshot and updating the labels, `pnpm evaluate:dip --
fixtures/dip/embedding-eval.reviewed.json` completed all 16 queries. The
[full result](dip-missing-pdf-eval-2026-11-09.json) retains all ranked hits.
Mean recall@5 was **0.874**, recall@10 **0.907**, and MRR@10 **1.000**.
The two climate queries reached recall@10 **0.556** each; the grid-charge
queries reached **1.000** each and ranked PDF 291288 page 48. The first
climate hits were proceeding 338509 (German) and PDF 290322 page 1 (English).

The [7 November baseline](dip-embedding-eval-2026-11-07.md) reported 0.704,
0.754, and 0.875 for those three metrics. This is a diagnostic before/after
comparison, not an isolated effect estimate: the label denominators expanded,
page deduplication and grid-charge ranking changed in other work, and the
production corpus is live. No retrieval ranking or automatic PDF window was
changed for this issue.
