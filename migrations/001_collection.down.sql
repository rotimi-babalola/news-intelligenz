DROP TABLE discoveries, candidates, publication_identifiers, publications, runs;
DELETE FROM schema_migrations WHERE version = '001_collection';
