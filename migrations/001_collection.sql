CREATE TABLE runs (
  id text PRIMARY KEY,
  feed_id text NOT NULL,
  input_hash text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  valid_count integer NOT NULL DEFAULT 0,
  invalid_count integer NOT NULL DEFAULT 0,
  error text
);
CREATE TABLE publications (
  id uuid PRIMARY KEY,
  publisher text NOT NULL,
  headline text NOT NULL,
  original_url text NOT NULL,
  published_at timestamptz,
  language text NOT NULL CHECK (language IN ('de', 'en')),
  content_availability text NOT NULL DEFAULT 'metadata_only'
    CHECK (content_availability = 'metadata_only'),
  first_discovered_at timestamptz NOT NULL DEFAULT now(),
  last_discovered_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE publication_identifiers (
  publisher text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('guid', 'url')),
  value text NOT NULL,
  publication_id uuid NOT NULL REFERENCES publications(id),
  PRIMARY KEY (publisher, kind, value)
);
CREATE TABLE candidates (
  run_id text NOT NULL REFERENCES runs(id),
  item_index integer NOT NULL,
  metadata jsonb NOT NULL,
  errors jsonb NOT NULL,
  publication_id uuid REFERENCES publications(id),
  PRIMARY KEY (run_id, item_index)
);
CREATE TABLE discoveries (
  run_id text NOT NULL REFERENCES runs(id),
  publication_id uuid NOT NULL REFERENCES publications(id),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, publication_id)
);
