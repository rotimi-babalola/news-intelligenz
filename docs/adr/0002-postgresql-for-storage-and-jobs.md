# Use PostgreSQL for persistent collection data and jobs

Phase 1 uses PostgreSQL for publications, text versions, discoveries, operational records, review decisions, and durable processing jobs. Keeping jobs in the same database avoids an additional queue service during the exploratory phase while supporting retries and recovery. This couples initial job processing to PostgreSQL and requires safe job claiming and idempotent processing; a separate queue can be considered if measured load warrants it.
