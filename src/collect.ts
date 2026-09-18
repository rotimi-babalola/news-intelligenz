import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { feed, parseFeed, type Candidate } from "./feed.js";

export async function collect(pool: pg.Pool, runId: string, xml: string) {
  if (!runId.trim() || runId.length > 200)
    throw new Error("Run ID must contain 1–200 characters");
  const hash = createHash("sha256").update(xml).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One configured collector; serialize identity resolution and concurrent replay.
    await client.query("SELECT pg_advisory_xact_lock(8135421)");
    const previous = await client.query("SELECT * FROM runs WHERE id = $1", [
      runId,
    ]);
    if (previous.rowCount) {
      const run = previous.rows[0];
      if (run.input_hash !== hash || run.feed_id !== feed.id)
        throw new Error(
          "Run ID already belongs to a different input; use a new run ID",
        );
      await client.query("COMMIT");
      return run;
    }
    await client.query(
      "INSERT INTO runs (id, feed_id, input_hash, status) VALUES ($1, $2, $3, 'running')",
      [runId, feed.id, hash],
    );
    let candidates: Candidate[] = [];
    let parseError: string | null = null;
    try {
      candidates = parseFeed(xml);
    } catch (error) {
      parseError =
        error instanceof Error ? error.message : "Feed parsing failed";
    }
    let valid = 0;
    for (const [index, candidate] of candidates.entries()) {
      const { errors, ...metadata } = candidate;
      let publicationId: string | null = null;
      if (!errors.length) {
        const matches = await client.query(
          "SELECT DISTINCT publication_id FROM publication_identifiers WHERE publisher = $1 AND ((kind = 'url' AND value = $2) OR (kind = 'guid' AND value = $3 AND $3 <> ''))",
          [feed.publisher, candidate.originalUrl, candidate.sourceId],
        );
        if (matches.rows.length > 1)
          errors.push(
            "Conflicting publication identities; manual inspection required",
          );
        else {
          publicationId = matches.rows[0]?.publication_id ?? randomUUID();
          await client.query(
            `INSERT INTO publications (id, publisher, headline, original_url, published_at, language)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE SET headline = EXCLUDED.headline,
             original_url = EXCLUDED.original_url, published_at = EXCLUDED.published_at,
             language = EXCLUDED.language, last_discovered_at = now()`,
            [
              publicationId,
              feed.publisher,
              candidate.headline,
              candidate.originalUrl,
              candidate.publishedAt,
              candidate.language,
            ],
          );
          for (const [kind, value] of [
            ["url", candidate.originalUrl],
            ["guid", candidate.sourceId],
          ]) {
            if (value)
              await client.query(
                "INSERT INTO publication_identifiers VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
                [feed.publisher, kind, value, publicationId],
              );
          }
          await client.query(
            "INSERT INTO discoveries (run_id, publication_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [runId, publicationId],
          );
          valid++;
        }
      }
      await client.query("INSERT INTO candidates VALUES ($1, $2, $3, $4, $5)", [
        runId,
        index,
        JSON.stringify(metadata),
        JSON.stringify(errors),
        publicationId,
      ]);
    }
    const result = await client.query(
      `UPDATE runs SET status = $2, completed_at = clock_timestamp(), valid_count = $3,
       invalid_count = $4, error = $5 WHERE id = $1 RETURNING *`,
      [
        runId,
        parseError ? "failed" : "completed",
        valid,
        candidates.length - valid,
        parseError,
      ],
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
