import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { PrismaClient } from "./generated/prisma/client.js";
import { drainJobs, finalizeRunIfSettled } from "./collect.js";
import { jobCounts, listJobs, retryExhausted } from "./jobs.js";

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

export function adminServer(prisma: PrismaClient) {
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
    if (request.method === "POST" && (request.url ?? "/") === "/jobs/retry") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 10_000) break;
      }
      const jobId = new URLSearchParams(body).get("id") ?? "";
      try {
        if (!jobId) throw new Error("Missing job id");
        const retried = await retryExhausted(prisma, jobId);
        await drainJobs(prisma, "admin-retry", { runId: retried.runId });
        const run = await prisma.run.findUniqueOrThrow({
          where: { id: retried.runId },
        });
        await finalizeRunIfSettled(prisma, retried.runId, run.error);
        response.writeHead(303, { Location: "/#jobs" }).end();
      } catch (error) {
        response.writeHead(303, { Location: "/#jobs" }).end();
        console.error(
          "Job retry failed:",
          error instanceof Error ? error.message : "Unknown error",
        );
      }
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET, POST" }).end();
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
      const publications = await prisma.publication.findMany({
        orderBy: [{ lastDiscoveredAt: "desc" }, { id: "asc" }],
        take: 100,
        include: { _count: { select: { discoveries: true } } },
      });
      const runs = await prisma.run.findMany({
        orderBy: [{ startedAt: "desc" }, { id: "asc" }],
        take: 100,
      });
      const selectedRun = url.searchParams.get("run") ?? runs[0]?.id ?? "";
      const candidates = await prisma.candidate.findMany({
        where: { runId: selectedRun },
        orderBy: { itemIndex: "asc" },
        take: 100,
      });
      const discoveries = await prisma.discovery.findMany({
        where: { runId: selectedRun },
        orderBy: { publicationId: "asc" },
        take: 100,
        include: { run: true, publication: true },
      });
      const counts = await jobCounts(prisma);
      const attention = [
        ...(await listJobs(prisma, "retrying")),
        ...(await listJobs(prisma, "exhausted")),
      ]
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
        .slice(0, 100);
      const publicationRows = publications
        .map(
          (p) =>
            `<tr><td lang="${escape(p.language)}"><a href="${escape(p.originalUrl)}" rel="noreferrer">${escape(p.headline)}</a><small>${escape(p.originalUrl)}</small></td><td>${escape(p.publisher)}</td><td>${date(p.publishedAt)}</td><td>${date(p.firstDiscoveredAt)}<small>Last: ${date(p.lastDiscoveredAt)}</small></td><td>Metadata only<small>Article text not collected</small></td><td>${escape(p._count.discoveries)}</td></tr>`,
        )
        .join("");
      const runRows = runs
        .map(
          (r) =>
            `<tr><td><a href="/?run=${encodeURIComponent(r.id)}#candidates">${escape(r.id)}</a><small>${escape(r.feedId)}</small></td><td>${escape(r.status)}<small>${escape(r.error ?? "")}</small></td><td>${date(r.startedAt)}<small>Completed: ${date(r.completedAt)}</small></td><td>${r.validCount}</td><td>${r.invalidCount}</td></tr>`,
        )
        .join("");
      const candidateRows = candidates
        .map((c) => {
          const metadata = c.metadata as { headline?: unknown };
          const errors = c.errors as unknown[];
          return `<tr><td>${c.itemIndex + 1}</td><td>${escape(metadata.headline)}<details><summary>Retained metadata</summary><pre>${escape(JSON.stringify(c.metadata, null, 2))}</pre></details></td><td>${errors.length ? `<strong>Rejected</strong><ul>${errors.map((e) => `<li>${escape(e)}</li>`).join("")}</ul>` : "Accepted"}</td></tr>`;
        })
        .join("");
      const jobRows = attention
        .map(
          (j) =>
            `<tr><td>${escape(j.sourceKey)}<small>${escape(j.sourceKind)} · Run ${escape(j.runId)}${j.itemIndex === null ? "" : ` · Item ${j.itemIndex + 1}`}</small></td><td>${escape(j.status)}<small>Attempt ${j.attempts}/${j.maxAttempts} · Next: ${date(j.nextAttemptAt)}</small></td><td>${escape(j.lastError ?? "")}</td><td>${j.status === "exhausted" ? `<form method="post" action="/jobs/retry"><input type="hidden" name="id" value="${escape(j.id)}"><button type="submit">Retry</button></form>` : ""}</td></tr>`,
        )
        .join("");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>News Intelligenz · Local inspection</title><link rel="stylesheet" href="/admin.css"></head><body><main>
        <header><p class="eyebrow">NEWS INTELLIGENZ / LOCAL ADMIN</p><h1>Collection inspection</h1><p>Inspect publications and the encounters that brought them here.</p></header>
        <aside><strong>Live feeds: nine public-news feeds (tagesschau + 8 Deutschlandfunk)</strong><p>Collection runs against the configured public-news feeds and the synthetic fixture. Live retention terms are on record; see the verification report. No article text is retained.</p></aside>
        <nav aria-label="Page sections"><a href="#publications">Publications</a><a href="#runs">Runs</a><a href="#candidates">Candidates</a><a href="#jobs">Jobs</a></nav>
        <section id="publications"><h2>Publications</h2><p>Latest 100 · Original German/English text · All dates in UTC</p><div class="table-scroll" tabindex="0" role="region" aria-label="Publications table"><table><thead><tr><th scope="col">Headline / original URL</th><th scope="col">Publisher</th><th scope="col">Published</th><th scope="col">Discovered</th><th scope="col">Content availability</th><th scope="col">Discoveries</th></tr></thead><tbody>${publicationRows || '<tr><td colspan="6">No publications yet. Run the collector to begin.</td></tr>'}</tbody></table></div></section>
        <section id="runs"><h2>Collection runs</h2><p>Latest 100 · Select a run to inspect its candidates and discoveries.</p><div class="table-scroll" tabindex="0" role="region" aria-label="Collection runs table"><table><thead><tr><th scope="col">Run / feed</th><th scope="col">Result</th><th scope="col">Started</th><th scope="col">Valid candidates</th><th scope="col">Invalid candidates</th></tr></thead><tbody>${runRows || '<tr><td colspan="5">No runs yet.</td></tr>'}</tbody></table></div></section>
        <section id="candidates"><h2>Candidates</h2><p>Run: ${escape(selectedRun || "None")} · First 100 entries</p><div class="table-scroll" tabindex="0" role="region" aria-label="Candidates table"><table><thead><tr><th scope="col">Item</th><th scope="col">Headline / metadata</th><th scope="col">Validation</th></tr></thead><tbody>${candidateRows || '<tr><td colspan="3">No candidates in this run.</td></tr>'}</tbody></table></div>
        <h3>Discovery history for this run</h3><p>First 100 encounters; repeated items in one feed/run count once per publication.</p><ul>${discoveries.map((d) => `<li>${escape(d.publication.headline)} — ${escape(d.run.feedId)} · ${date(d.discoveredAt)}</li>`).join("") || "<li>No discoveries in this run.</li>"}</ul></section>
        <section id="jobs"><h2>Processing jobs</h2><p>Pending (incl. claimed): ${counts.pending} · Retrying: ${counts.retrying} · Exhausted: ${counts.exhausted}</p><p>Retrying jobs resume automatically with backoff. Exhausted jobs stay visible until deliberately retried; retrying one reprocesses its run immediately.</p><div class="table-scroll" tabindex="0" role="region" aria-label="Processing jobs table"><table><thead><tr><th scope="col">Source / run</th><th scope="col">State</th><th scope="col">Last error</th><th scope="col">Action</th></tr></thead><tbody>${jobRows || '<tr><td colspan="4">No retrying or exhausted jobs.</td></tr>'}</tbody></table></div></section>
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
