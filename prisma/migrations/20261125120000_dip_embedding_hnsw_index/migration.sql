-- Prisma cannot express a pgvector HNSW index, so it lives only here.
-- Candidate-first search orders by cosine distance, so the index serves the
-- inner ORDER BY ... LIMIT without scoring every embedding. Build it
-- concurrently: the table holds the full corpus and a plain build would block
-- writes for the duration. The build scans every row and writes the index, so
-- expect a longer run and extra I/O on the production branch. A failed
-- concurrent build leaves an invalid index, so a retry must drop it first.
-- Keep this file to one statement: Prisma only skips the wrapping transaction
-- for single-statement migrations, and CONCURRENTLY cannot run inside one.
CREATE INDEX CONCURRENTLY "dip_embeddings_embedding_hnsw_idx"
    ON "dip_embeddings" USING hnsw ("embedding" public.vector_cosine_ops);
