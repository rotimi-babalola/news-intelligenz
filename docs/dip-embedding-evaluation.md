# DIP embedding comparison

## From PDFs to retrieval

Cloudflare R2 stores the original PDF bytes. Neon stores extracted page text,
passages, and pgvector embeddings. Retrieval combines current proceedings,
steps, and PDF passages; a PDF hit includes its document reference and page.
No answer-generation layer is present yet. A RAG answer should use these
retrieved evidence units and cite their DIP source and PDF page.

For candidate models, run the 10% reindex and reindex-only drain commands
below. Review German and English queries with both proceeding and PDF page
labels. Before deploying a search configuration with a new index ID, run the
new code against the target database with the selected provider settings to
queue and drain a 100% reindex:

```sh
DIP_REINDEX_SAMPLE_PERCENT=100 pnpm reindex:dip
DIP_DOCUMENT_DRAIN_CAP=0 DIP_EMBEDDING_REINDEX_ONLY=1 pnpm drain:dip
```

Repeat the drain until no reindex jobs remain, then switch the search service
to the same configuration. A 10% sample and the existing pending jobs do not
cover sources already embedded under the previous index ID. After switching,
drain the unscoped production backlog with `pnpm drain:dip`; legacy page jobs
create passage jobs as they run. The full reindex may bill the provider again
for sources already embedded. Use the same provider, model, and instruction
settings for reindex, drain, and search.
Each distinct model or instruction combination needs its own index ID
and vector jobs. Local Ollama must run on the machine executing the drain; a
remote Render worker cannot reach Ollama on your laptop's `127.0.0.1`.

Run the comparison against one fixed Neon branch or a paused collection window.
The reindex command uses a stable hash sample of the latest stored proceedings,
steps, and extracted PDF passages. Its default sample is 10%, the same IDs for
every model. Set `DIP_REINDEX_SAMPLE_PERCENT=100` for the full corpus. It does
not fetch DIP records or PDFs. Document pages only exist after
`process_document` jobs finish.

Use the same labeled queries for every model. Each label identifies the exact
relevant evidence unit; a document label includes its page:

```json
{
  "reviewed": true,
  "cases": [
    {
      "query": "Welche Beratungen gibt es zu bezahlbarem Wohnraum?",
      "relevant": [
        { "entity": "vorgang", "apiId": "REPLACE_WITH_REAL_DIP_ID" },
        {
          "entity": "dokument",
          "apiId": "REPLACE_WITH_REAL_REFERENCE_ID",
          "page": 3
        }
      ]
    }
  ]
}
```

Create German and English queries across several topics and label their results
from the stored records before comparing models. The script reports recall@5,
recall@10, MRR@10, query latency, and the top results for inspection. Labels
must be real IDs from the evaluation branch; the example above is only a format
example.
The [draft query set](../fixtures/dip/embedding-eval.draft.json) contains 16
German and English questions grounded in public DIP titles from the configured
Neon database. Review each positive label, add other relevant proceedings,
steps, and document pages, then set `reviewed` to `true` in a copy. The
evaluator refuses an unreviewed file.

For each candidate, set these variables in the shell or a private env file:

| Variable                             | Meaning                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `EMBEDDING_MODEL`                    | Provider's model name; defaults to `text-embedding-3-small`                                                              |
| `EMBEDDING_INDEX_ID`                 | Optional stable override for the index identity; otherwise derived from format, URL, model, dimensions, and instructions |
| `EMBEDDING_BASE_URL`                 | API base URL ending at `/v1`; defaults to OpenAI's URL for `openai`, localhost for `ollama`; required for `voyage`       |
| `EMBEDDING_API_KEY`                  | Provider secret; defaults to `OPENAI_API_KEY` only for the default OpenAI endpoint; never commit it                      |
| `EMBEDDING_API_FORMAT`               | Wire format: `openai`, `voyage`, or `ollama`; defaults to `openai`                                                       |
| `EMBEDDING_QUERY_INSTRUCTION`        | Optional query prefix; defaults to empty for hosted models and the existing instruction for Ollama                       |
| `EMBEDDING_DOCUMENT_INSTRUCTION`     | Optional document prefix; defaults to empty                                                                              |
| `EMBEDDING_PRICE_PER_MILLION_TOKENS` | Optional input token price in your chosen currency for an estimated cost; verify billed usage with the provider          |

The derived index ID changes when the format, endpoint, model, or instructions
change. If you override it, change the override whenever the embedding space
changes. The current database accepts only 1024-dimensional vectors.
The provider client checks this before saving. The `model` column stores the
index ID, and each row records both instructions, so candidate indexes coexist.
Search filters by index ID and instructions and never mixes their vectors. For an operator comparison, change the environment
to the desired model before calling the search API or evaluation command.

```sh
pnpm reindex:dip
DIP_DOCUMENT_DRAIN_CAP=0 DIP_EMBEDDING_REINDEX_ONLY=1 pnpm drain:dip
pnpm evaluate:dip -- path/to/labels.json
```

Reindexing splits retained page text without fetching PDFs again. Search
excludes legacy whole-page vectors, so PDF results return as passage jobs
complete. The command also queues current proceeding and step versions;
already stored vectors are retained, but those jobs still call the embedding
provider.

Repeat the drain until it reports no work. Reindex-only mode leaves the existing
unscoped production backlog untouched during comparison. Label examples from
the sampled index so all candidates see the same evidence. `DIP_DOCUMENT_DRAIN_CAP`
(default 100) and `DIP_EMBEDDING_DRAIN_CAP` (default 500) bound each run. Set the
document cap to `0` when comparing only existing extracted text. Provider 429s
honor `Retry-After`; the drain stops after a retrying embedding job so an outage
does not consume the rest of the queue's retry budget. The existing admin DIP
page shows pending, retrying, and exhausted jobs.

After selecting a model, apply migrations, complete the full reindex above,
then run `pnpm drain:dip` as a separate Render cron. An hourly `15 * * * *` UTC
schedule starts after the existing daily collection trigger. Configure the
pooled `DATABASE_URL`, R2
object storage, Python/PyMuPDF, and the chosen embedding provider on that
service. Leave `DIP_EMBEDDING_REINDEX_ONLY` unset. The document drain runs
first, then the embedding drain. Run the same command manually for backfill;
it consumes existing pending jobs without re-collecting. A hosted smoke test
is opt-in with `HOSTED_EMBEDDING_QA=1` and the
chosen provider environment.

## Render PDF drain setup

Create a second Render cron job from this repository with Docker runtime and
`Dockerfile.cron`. The image includes Node 24, Python, PyMuPDF, and the compiled
worker; its default command is `node dist/scripts/drain-dip.js`. For the
initial document backlog, schedule `*/15 * * * *` UTC and set:

```text
DATABASE_URL=<Neon pooled connection string>
R2_ENDPOINT=<the S3 API endpoint shown for your R2 bucket>
R2_BUCKET=<bucket name>
R2_ACCESS_KEY_ID=<bucket-scoped Object Read & Write key ID>
R2_SECRET_ACCESS_KEY=<matching secret>
DIP_DOCUMENT_DRAIN_CAP=25
DIP_EMBEDDING_DRAIN_CAP=0
```

The bucket and its key must permit uploads. An EU-jurisdiction R2 bucket uses
the `.eu.r2.cloudflarestorage.com` endpoint; a standard bucket uses
`.r2.cloudflarestorage.com`. These are Render service environment variables,
not Docker build arguments or values committed to Git. No embedding provider
credentials are needed while the embedding cap is zero. The collector's
`BUNDESTAG_API_KEY` and `DIP_RUN_HOUR` are not needed on this worker.

Apply database migrations once before triggering the first run. The cron
container has Prisma installed, so its temporary Render Shell can run
`pnpm db:migrate` when `DATABASE_URL_UNPOOLED` is set to Neon's direct
connection string. Then trigger one run and confirm `document_contents` and
`document_pages` increase. After the backlog clears, an hourly
`15 * * * *` schedule is sufficient for maintenance. Once a model is chosen,
add its embedding variables and raise `DIP_EMBEDDING_DRAIN_CAP` above zero.
