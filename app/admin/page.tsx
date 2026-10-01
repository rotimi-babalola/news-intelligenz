import { headers } from "next/headers";
import { getAdminOverview } from "../../src/admin/service";
import { retryJobAction } from "./actions";

export const dynamic = "force-dynamic";

function date(value: Date | null) {
  return value ? value.toISOString() : "Unknown";
}

function isLocal(host: string) {
  return /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(host);
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams?: Promise<{ run?: string }>;
}) {
  const host = (await headers()).get("host") ?? "";
  if (host && !isLocal(host)) return <p>Local access only</p>;

  const params = searchParams ? await searchParams : {};
  const {
    publications,
    runs,
    selectedRun,
    candidates,
    discoveries,
    counts,
    attention,
  } = await getAdminOverview(params.run);

  return (
    <main>
      <header>
        <p className="eyebrow">NEWS INTELLIGENZ / LOCAL ADMIN</p>
        <h1>Collection inspection</h1>
        <p>Inspect publications and the encounters that brought them here.</p>
      </header>
      <aside>
        <strong>
          Live feeds: nine public-news feeds (tagesschau + 8 Deutschlandfunk)
        </strong>
        <p>
          Collection runs against the configured public-news feeds and the
          synthetic fixture. Live retention terms are on record; see the
          verification report. No article text is retained.
        </p>
      </aside>
      <nav aria-label="Page sections">
        <a href="#publications">Publications</a>
        <a href="#runs">Runs</a>
        <a href="#candidates">Candidates</a>
        <a href="#jobs">Jobs</a>
      </nav>
      <section id="publications">
        <h2>Publications</h2>
        <p>Latest 100 · Original German/English text · All dates in UTC</p>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Publications table"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Headline / original URL</th>
                <th scope="col">Publisher</th>
                <th scope="col">Published</th>
                <th scope="col">Discovered</th>
                <th scope="col">Content availability</th>
                <th scope="col">Discoveries</th>
              </tr>
            </thead>
            <tbody>
              {publications.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    No publications yet. Run the collector to begin.
                  </td>
                </tr>
              )}
              {publications.map((p) => (
                <tr key={p.id}>
                  <td lang={p.language}>
                    <a href={p.originalUrl} rel="noreferrer">
                      {p.headline}
                    </a>
                    <small>{p.originalUrl}</small>
                  </td>
                  <td>{p.publisher}</td>
                  <td>{date(p.publishedAt)}</td>
                  <td>
                    {date(p.firstDiscoveredAt)}
                    <small>Last: {date(p.lastDiscoveredAt)}</small>
                  </td>
                  <td>
                    Metadata only
                    <small>Article text not collected</small>
                  </td>
                  <td>{p._count.discoveries}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section id="runs">
        <h2>Collection runs</h2>
        <p>
          Latest 100 · Select a run to inspect its candidates and discoveries.
        </p>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Collection runs table"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Run / feed</th>
                <th scope="col">Result</th>
                <th scope="col">Started</th>
                <th scope="col">Valid candidates</th>
                <th scope="col">Invalid candidates</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td colSpan={5}>No runs yet.</td>
                </tr>
              )}
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a
                      href={`/admin?run=${encodeURIComponent(r.id)}#candidates`}
                    >
                      {r.id}
                    </a>
                    <small>{r.feedId}</small>
                  </td>
                  <td>
                    {r.status}
                    <small>{r.error ?? ""}</small>
                  </td>
                  <td>
                    {date(r.startedAt)}
                    <small>Completed: {date(r.completedAt)}</small>
                  </td>
                  <td>{r.validCount}</td>
                  <td>{r.invalidCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section id="candidates">
        <h2>Candidates</h2>
        <p>Run: {selectedRun || "None"} · First 100 entries</p>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Candidates table"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Headline / metadata</th>
                <th scope="col">Validation</th>
              </tr>
            </thead>
            <tbody>
              {candidates.length === 0 && (
                <tr>
                  <td colSpan={3}>No candidates in this run.</td>
                </tr>
              )}
              {candidates.map((c) => {
                const metadata = c.metadata as { headline?: unknown };
                const errors = c.errors as unknown[];
                return (
                  <tr key={`${c.runId}:${c.itemIndex}`}>
                    <td>{c.itemIndex + 1}</td>
                    <td>
                      {String(metadata.headline ?? "Unknown")}
                      <details>
                        <summary>Retained metadata</summary>
                        <pre>{JSON.stringify(c.metadata, null, 2)}</pre>
                      </details>
                    </td>
                    <td>
                      {errors.length ? (
                        <>
                          <strong>Rejected</strong>
                          <ul>
                            {errors.map((e, i) => (
                              <li key={i}>{String(e)}</li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        "Accepted"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <h3>Discovery history for this run</h3>
        <p>
          First 100 encounters; repeated items in one feed/run count once per
          publication.
        </p>
        <ul>
          {discoveries.length === 0 && <li>No discoveries in this run.</li>}
          {discoveries.map((d) => (
            <li key={`${d.runId}:${d.publicationId}`}>
              {d.publication.headline} — {d.run.feedId} · {date(d.discoveredAt)}
            </li>
          ))}
        </ul>
      </section>
      <section id="jobs">
        <h2>Processing jobs</h2>
        <p>
          Pending (incl. claimed): {counts.pending} · Retrying:{" "}
          {counts.retrying} · Exhausted: {counts.exhausted}
        </p>
        <p>
          Retrying jobs resume automatically with backoff. Exhausted jobs stay
          visible until deliberately retried; retrying one reprocesses its run
          immediately.
        </p>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Processing jobs table"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Source / run</th>
                <th scope="col">State</th>
                <th scope="col">Last error</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {attention.length === 0 && (
                <tr>
                  <td colSpan={4}>No retrying or exhausted jobs.</td>
                </tr>
              )}
              {attention.map((j) => (
                <tr key={j.id}>
                  <td>
                    {j.sourceKey}
                    <small>
                      {j.sourceKind} · Run {j.runId}
                      {j.itemIndex === null ? "" : ` · Item ${j.itemIndex + 1}`}
                    </small>
                  </td>
                  <td>
                    {j.status}
                    <small>
                      Attempt {j.attempts}/{j.maxAttempts} · Next:{" "}
                      {date(j.nextAttemptAt)}
                    </small>
                  </td>
                  <td>{j.lastError ?? ""}</td>
                  <td>
                    {j.status === "exhausted" && (
                      <form action={retryJobAction}>
                        <input type="hidden" name="id" value={j.id} />
                        <button type="submit">Retry</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <footer>Local operator view · Refresh to see newly collected runs</footer>
    </main>
  );
}
