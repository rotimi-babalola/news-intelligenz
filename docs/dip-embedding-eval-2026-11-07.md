# DIP retrieval evaluation, 7 November 2026

## Reproduce

Run `pnpm evaluate:dip -- fixtures/dip/embedding-eval.reviewed.json` with the
configured production Neon branch and the same embedding settings. The
[reviewed labels](../fixtures/dip/embedding-eval.reviewed.json) cover eight topics
with German and English queries. The [full evaluator output](dip-embedding-eval-2026-11-07.json)
retains all 160 ranked results, scores, and per-query latencies. No collection,
reindexing, or retrieval tuning was performed for this evaluation.

The evaluation ran between 14:20:25 and 14:21:51 UTC. Before and after the run,
the branch held 3,499 proceedings, 33,386 steps, 410 current fetched documents,
5,004 extracted pages, 15,593 passages, and 51,935 embeddings. Proceeding
`last_observed_at` remained 06:02:33 UTC; the latest step observation was
06:02:45 UTC, latest PDF fetch 5 November 06:15:58 UTC, and latest embedding
write 07 November 02:01:15 UTC. These checks found no corpus or index changes
during the run. The production branch was not an immutable database snapshot.

Index ID: `openai:text-embedding-3-small:9e33b9fd2b34`; provider/model:
OpenAI `text-embedding-3-small`, 1,024 dimensions; base URL:
`https://api.openai.com/v1`; query and document instructions: empty. The index
had 3,260 proceeding, 33,082 step, and 15,593 PDF passage vectors. All 27
distinct labeled evidence units existed in current stored records and had an
index row. Each query used the evaluator's top 10 results and exact
entity/ID/page matching; multiple chunks from one PDF page count once toward
recall but occupy multiple ranking slots.

## Results

| Queries   | Mean recall@5 | Mean recall@10 | MRR@10 | Mean latency |
| --------- | ------------: | -------------: | -----: | -----------: |
| All 16    |         0.704 |          0.754 |  0.875 |     2,424 ms |
| German 8  |         0.692 |          0.767 |  0.875 |     3,526 ms |
| English 8 |         0.717 |          0.742 |  0.875 |     1,323 ms |

The first query took 19,441 ms, so the mean includes a cold-start outlier; the
median across all 16 was 1,231 ms. The run used 253 provider-billed query
tokens. No input-token price was configured, so estimated cost is unavailable.

|   # | Topic / language          | Recall@5 | Recall@10 | RR@10 | Latency ms | First result      |
| --: | ------------------------- | -------: | --------: | ----: | ---------: | ----------------- |
|   1 | Housing costs / DE        |    1.000 |     1.000 |     1 |     19,441 | proceeding 339930 |
|   2 | Housing costs / EN        |    1.000 |     1.000 |     1 |      1,954 | step 700983       |
|   3 | Climate allocations / DE  |    0.333 |     0.333 |     1 |      1,477 | proceeding 338509 |
|   4 | Climate allocations / EN  |    0.333 |     0.333 |     1 |      1,230 | proceeding 338509 |
|   5 | Grid charges / DE         |        0 |         0 |     0 |      1,145 | PDF 291709 p1     |
|   6 | Grid charges / EN         |        0 |         0 |     0 |      1,210 | PDF 291709 p1     |
|   7 | Migration employment / DE |    1.000 |     1.000 |     1 |      1,231 | step 673410       |
|   8 | Migration employment / EN |    1.000 |     1.000 |     1 |      1,226 | step 673410       |
|   9 | Care level / DE           |    1.000 |     1.000 |     1 |      1,229 | step 679549       |
|  10 | Care level / EN           |    1.000 |     1.000 |     1 |      1,330 | step 679549       |
|  11 | Applied sciences / DE     |    0.600 |     1.000 |     1 |      1,233 | PDF 291815 p1     |
|  12 | Applied sciences / EN     |    0.800 |     1.000 |     1 |      1,143 | PDF 291815 p1     |
|  13 | Motorway funding / DE     |    0.800 |     1.000 |     1 |      1,311 | PDF 292037 p1     |
|  14 | Motorway funding / EN     |    0.800 |     0.800 |     1 |      1,317 | step 701438       |
|  15 | Military procurement / DE |    0.800 |     0.800 |     1 |      1,140 | proceeding 340267 |
|  16 | Military procurement / EN |    0.800 |     0.800 |     1 |      1,170 | step 701560       |

## Manual source checks and failure modes

- **Exact grid-charge item misses in both languages.** The indexed
  [proceeding 340178](https://search.dip.bundestag.de/api/v1/vorgang/340178)
  and [step 701442](https://search.dip.bundestag.de/api/v1/vorgangsposition/701442)
  concern charges through 2045, but neither appears in either top 10. The first
  result in both languages is [PDF 21/8654 p1](https://dserver.bundestag.de/btd/21/086/2108654.pdf),
  reference 291709, about a different grid-charge reform starting in 2029.
  It is related evidence, but does not identify the requested 2045 item. The
  requested item's linked PDF 21/8312 has no stored extracted pages. This is
  an exact-item ranking miss plus a separate PDF corpus gap.
- **Climate proceeding found, linked steps absent.** Both languages rank
  [proceeding 338509](https://search.dip.bundestag.de/api/v1/vorgang/338509)
  first, but neither indexed `Unterrichtung` step 698621/698672 reaches the
  top 10. The German top 10 includes [PDF 21/8876 p3](https://dserver.bundestag.de/btd/21/088/2108876.pdf),
  reference 292046, whose stored text concerns climate reparations rather than
  emissions allocations. None of the four linked PDFs for proceeding 338509
  has extracted pages; that is a corpus gap, not a PDF ranking miss.
- **Repeated passage hits consume result slots.** Eight of 16 top-10 lists
  repeat the same PDF reference and page, totaling 15 repeated rows. For
  applied sciences in German, PDF 291815 p1 occupies ranks 1, 3, and 4;
  [p1](https://dserver.bundestag.de/btd/21/086/2108697.pdf) contains federal
  funding amounts, and p2 contains the detailed funding questions. For motorway
  funding, [PDF 21/8868 p1–2](https://dserver.bundestag.de/btd/21/088/2108868.pdf)
  explains the proposed three-source financing and borrowing authority; p1
  repeats at ranks 1, 2, and 9 in German. Page labels use extracted PDF page
  numbers, not the document's printed page numbers.
- **Procurement source and page checked.** The German top four contain
  proceeding 340267, steps 701560/701949, and [transcript 21/101 PDF p131](https://dserver.bundestag.de/btp/21/21101.pdf#P.12759),
  reference 5819. The stored p131 text has questions 37–38 and the answer on
  roughly 1,800 price reviews. PDF p132 continues the answer with the market
  observation and price-control units. P132 is labeled but absent from both
  top 10 lists. The URL fragment points to printed page 12759; the extracted
  PDF page label is 131. The English top 10 also includes PDF 291613 p6, whose
  stored text concerns infrastructure approvals and is irrelevant here.

Twelve of the 15 document references attached to the eight labeled proceedings
have no current extracted PDF pages, including the grid-charge and climate
sources. They were excluded from relevance labels and recall denominators;
their absence is recorded as a corpus or extraction gap. All eight target
proceedings and their labeled steps were present and indexed, so the two
grid-charge misses and climate-step misses are ranking failures within the
available index. This small, topic-selected query set is diagnostic rather
than an estimate of general production retrieval quality.

## Next work

1. **Deduplicate PDF pages in the top results.** Keep the best scoring passage
   per document reference and page, then fill the remaining top-10 slots from
   the ranked candidates. This directly addresses 15 repeated rows across
   eight queries without changing embeddings.
2. **Investigate the 2045 grid-charge exact-item miss.** Compare the indexed
   proceeding/step text and scores with nearby grid-charge records, then make
   the smallest ranking change that brings 340178 or 701442 into both top 10s.
   Test against both languages and the other 14 queries before adopting it.
3. **Process missing linked PDFs as corpus work.** The 12 absent references
   cannot be judged as retrieval misses. Prioritize the 2045 grid-charge and
   climate-allocation sources if their PDF content is needed for dossiers.

No re-embedding or model comparison is justified by this run alone.
