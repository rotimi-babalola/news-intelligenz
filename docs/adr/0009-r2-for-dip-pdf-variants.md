# Cloudflare R2 for fetched DIP PDF variants

Archive fetched PDF bytes in a private Cloudflare R2 bucket instead of the
PostgreSQL `document_contents.bytes` column. PostgreSQL keeps the variant row,
the SHA-256 byte hash, size, provenance and extracted page text; the object key
is `documents/<reference_id>/<byte_hash>.pdf`. This preserves the
content-addressed cache from [ADR 0005](0005-local-multilingual-dip-retrieval.md)
and its rule that identical bytes reuse one variant while changed bytes add a
retained variant.

The PDF archive was the fastest-growing part of the database: the 14-day hot
subset fetches roughly 450 MB of PDF bytes per month for the current electoral
term, while the relational records and embeddings fit comfortably in a small
managed Postgres. R2's free tier includes 10 GB of storage and zero egress, so
the archive stays free for well over a year at this rate. Keeping PDFs in
Postgres would have forced a Neon storage upgrade within months.

The bucket is private and bucket-scoped API tokens are used per environment;
development and production have separate buckets. The document worker is the
only component that needs R2 credentials, and tests inject a fake uploader so
CI never reaches R2. Object upload happens before the database transaction:
a failed upload retries the job, and a failed transaction leaves an object that
the same content-addressed key overwrites on retry. Retained variants are not
deleted automatically, matching the existing retention rule.
