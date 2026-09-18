import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type pg from "pg";

const escape = (value: unknown) =>
  String(value ?? "Unknown").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const date = (value: Date | null) =>
  value ? escape(value.toISOString()) : "Unknown";

export function adminServer(pool: pg.Pool) {
  return createServer(async (request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (
      !/^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(
        request.headers.host ?? "",
      )
    ) {
      response.writeHead(403).end("Local access only");
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/admin.css") {
        response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        response.end(await readFile("src/admin.css", "utf8"));
        return;
      }
      if (url.pathname !== "/") {
        response.writeHead(404).end("Not found");
        return;
      }
      const publications = await pool.query(
        `SELECT p.*, (SELECT count(*) FROM discoveries d WHERE d.publication_id = p.id) AS discoveries FROM publications p ORDER BY last_discovered_at DESC, id LIMIT 100`,
      );
      const runs = await pool.query(
        "SELECT * FROM runs ORDER BY started_at DESC, id LIMIT 100",
      );
      const selectedRun = url.searchParams.get("run") ?? runs.rows[0]?.id ?? "";
      const candidates = await pool.query(
        "SELECT * FROM candidates WHERE run_id = $1 ORDER BY item_index LIMIT 100",
        [selectedRun],
      );
      const discoveries = await pool.query(
        `SELECT d.*, r.feed_id, p.headline FROM discoveries d JOIN runs r ON r.id = d.run_id JOIN publications p ON p.id = d.publication_id WHERE d.run_id = $1 ORDER BY d.publication_id LIMIT 100`,
        [selectedRun],
      );
      const publicationRows = publications.rows
        .map(
          (p) =>
            `<tr><td lang="${escape(p.language)}"><a href="${escape(p.original_url)}" rel="noreferrer">${escape(p.headline)}</a><small>${escape(p.original_url)}</small></td><td>${escape(p.publisher)}</td><td>${date(p.published_at)}</td><td>${date(p.first_discovered_at)}<small>Last: ${date(p.last_discovered_at)}</small></td><td>Metadata only<small>Article text not collected</small></td><td>${escape(p.discoveries)}</td></tr>`,
        )
        .join("");
      const runRows = runs.rows
        .map(
          (r) =>
            `<tr><td><a href="/?run=${encodeURIComponent(r.id)}#candidates">${escape(r.id)}</a><small>${escape(r.feed_id)}</small></td><td>${escape(r.status)}<small>${escape(r.error ?? "")}</small></td><td>${date(r.started_at)}<small>Completed: ${date(r.completed_at)}</small></td><td>${r.valid_count}</td><td>${r.invalid_count}</td></tr>`,
        )
        .join("");
      const candidateRows = candidates.rows
        .map(
          (c) =>
            `<tr><td>${c.item_index + 1}</td><td>${escape(c.metadata.headline)}<details><summary>Retained metadata</summary><pre>${escape(JSON.stringify(c.metadata, null, 2))}</pre></details></td><td>${c.errors.length ? `<strong>Rejected</strong><ul>${c.errors.map((e: string) => `<li>${escape(e)}</li>`).join("")}</ul>` : "Accepted"}</td></tr>`,
        )
        .join("");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>News Intelligenz · Local inspection</title><link rel="stylesheet" href="/admin.css"></head><body><main>
        <header><p class="eyebrow">NEWS INTELLIGENZ / LOCAL ADMIN</p><h1>Collection inspection</h1><p>Inspect publications and the encounters that brought them here.</p></header>
        <aside><strong>Synthetic fixtures only</strong><p>Live Bundestag collection is disabled while metadata retention permissions remain unresolved. Headlines below are test data. No article text is retained.</p></aside>
        <nav aria-label="Page sections"><a href="#publications">Publications</a><a href="#runs">Runs</a><a href="#candidates">Candidates</a></nav>
        <section id="publications"><h2>Publications</h2><p>Latest 100 · Original German/English text · All dates in UTC</p><div class="table-scroll" tabindex="0" role="region" aria-label="Publications table"><table><thead><tr><th scope="col">Headline / original URL</th><th scope="col">Publisher</th><th scope="col">Published</th><th scope="col">Discovered</th><th scope="col">Content availability</th><th scope="col">Discoveries</th></tr></thead><tbody>${publicationRows || '<tr><td colspan="6">No publications yet. Run the fixture collector to begin.</td></tr>'}</tbody></table></div></section>
        <section id="runs"><h2>Collection runs</h2><p>Latest 100 · Select a run to inspect its candidates and discoveries.</p><div class="table-scroll" tabindex="0" role="region" aria-label="Collection runs table"><table><thead><tr><th scope="col">Run / feed</th><th scope="col">Result</th><th scope="col">Started</th><th scope="col">Valid candidates</th><th scope="col">Invalid candidates</th></tr></thead><tbody>${runRows || '<tr><td colspan="5">No runs yet.</td></tr>'}</tbody></table></div></section>
        <section id="candidates"><h2>Candidates</h2><p>Run: ${escape(selectedRun || "None")} · First 100 entries</p><div class="table-scroll" tabindex="0" role="region" aria-label="Candidates table"><table><thead><tr><th scope="col">Item</th><th scope="col">Headline / metadata</th><th scope="col">Validation</th></tr></thead><tbody>${candidateRows || '<tr><td colspan="3">No candidates in this run.</td></tr>'}</tbody></table></div>
        <h3>Discovery history for this run</h3><p>First 100 encounters; repeated items in one feed/run count once per publication.</p><ul>${discoveries.rows.map((d) => `<li>${escape(d.headline)} — ${escape(d.feed_id)} · ${date(d.discovered_at)}</li>`).join("") || "<li>No discoveries in this run.</li>"}</ul></section>
        <footer>Local operator view · Refresh to see newly collected runs</footer></main></body></html>`);
    } catch (error) {
      console.error(
        "Admin query failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      if (!response.headersSent)
        response.writeHead(503, {
          "Content-Type": "text/plain; charset=utf-8",
        });
      response.end(
        "Inspection unavailable. Check PostgreSQL and the server log, then refresh.",
      );
    }
  });
}
