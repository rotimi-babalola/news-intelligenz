// Tunables, external names and shared literals for the DIP pipeline. Keep
// values that shape behaviour here so each folder can be reviewed at a glance.

// DIP API
export const DIP_API_BASE_URL = "https://search.dip.bundestag.de/api/v1";
export const VORGANG_ENDPOINT = "/vorgang";
export const STEPS_ENDPOINT = "/vorgangsposition";
// Serialises collection writes across concurrent runs for one source.
export const DIP_INTAKE_LOCK_ID = 8135421;

// Collection
export const DEFAULT_ELECTORAL_TERMS = [21, 20];
export const LOCAL_PROCEEDING_CAP = 1000;
export const PAGE_FETCH_ATTEMPTS = 3;
export const PAGE_WRITE_BATCH_SIZE = 5;
export const STEP_FILTER_BATCH = 50;
// PDF background queue: documents dated in the previous 14 days.
export const HOT_DOCUMENT_MS = 14 * 24 * 60 * 60 * 1000;
export const SYNC_OVERLAP_MS = 6 * 60 * 60 * 1000;

// Documents
export const MAX_PDF_BYTES = 25_000_000;
export const PDF_FETCH_TIMEOUT_MS = 30_000;
export const DOCUMENT_BACKFILL_BATCH_SIZE = 100;
export const DOCUMENT_CHUNK_SIZE = 1200;
export const DOCUMENT_CHUNK_OVERLAP = 200;
export const DOCUMENT_CHUNK_BATCH_SIZE = 500;
export const MAX_DOCUMENT_PAGE_TEXT = 2000;
export const MAX_SECTION_HEADING_LENGTH = 200;

// Search
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_TIMEOUT_MS = 120_000;
export const DOCUMENT_INSTRUCTION = "";
export const QUERY_INSTRUCTION =
  "Given a German or English query, retrieve relevant German parliamentary proceedings and steps";
export const DOSSIER_STEP_WEIGHT = 0.005;
export const DOSSIER_RECENCY_WEIGHT = 0.03;
export const DOSSIER_CURRENT_ACTIVITY_WEIGHT = 0.02;
export const DOSSIER_CURRENT_ACTIVITY_DAYS = 30;
export const DOSSIER_STEP_COUNT_CAP = 10;
export const DOSSIER_DOCUMENT_LIMIT = 3;

// Jobs
export const EMBED_PROCEEDING = "embed_proceeding";
export const EMBED_STEP = "embed_step";
export const EMBED_DOCUMENT = "embed_document";
export const PROCESS_DOCUMENT = "process_document";
export const ON_DEMAND_PRIORITY = 10;
export const EMBED_JOB_BATCH_SIZE = 500;
export const REINDEX_PAGE_SIZE = 500;
export const REINDEX_DOCUMENT_PAGE_SIZE = 100;

// Explain
export const EXPLAIN_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const EXPLAIN_TIMEOUT_MS = 120_000;
export const BRIEF_CACHE_VERSION = 9;
export const MAX_BRIEF_QUESTION_LENGTH = 1000;
export const MIN_CLAIM_QUOTE_LENGTH = 12;
