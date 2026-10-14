import {
  Cpu,
  ExternalLink,
  History,
  Layers,
  ListChecks,
  Newspaper,
} from "lucide-react";
import { getNewsOverview } from "../../../src/admin/service";
import { Button } from "../../../src/components/ui/button";
import { Badge } from "../../../src/components/ui/badge";
import { cn } from "../../../src/lib/utils";
import { Pager } from "../_components/pager";
import { TableCard } from "../_components/table-card";
import { JobsTable } from "../_components/jobs-table";
import {
  formatDate,
  paginate,
  parsePage,
  runTone,
} from "../_components/display";

export const dynamic = "force-dynamic";

export default async function AdminPage({
  searchParams,
}: {
  searchParams?: Promise<{
    run?: string;
    pubPage?: string;
    runsPage?: string;
    candPage?: string;
    discPage?: string;
    jobsPage?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};
  const {
    publications,
    runs,
    selectedRun,
    candidates,
    discoveries,
    counts,
    attention,
  } = await getNewsOverview(params.run);

  const pubPage = parsePage(params.pubPage);
  const runsPage = parsePage(params.runsPage);
  const candPage = parsePage(params.candPage);
  const discPage = parsePage(params.discPage);
  const jobsPage = parsePage(params.jobsPage);

  const pub = paginate(publications, pubPage);
  const runList = paginate(runs, runsPage);
  const cand = paginate(candidates, candPage);
  const disc = paginate(discoveries, discPage);
  const jobs = paginate(attention, jobsPage);

  const pageState = {
    pubPage: pub.page,
    runsPage: runList.page,
    candPage: cand.page,
    discPage: disc.page,
    jobsPage: jobs.page,
  };

  function hrefFor(
    key: keyof typeof pageState,
    value: number,
    anchor: string,
  ): string {
    const query = new URLSearchParams();
    if (selectedRun) query.set("run", selectedRun);
    const all = { ...pageState, [key]: value };
    if (all.pubPage > 1) query.set("pubPage", String(all.pubPage));
    if (all.runsPage > 1) query.set("runsPage", String(all.runsPage));
    if (all.candPage > 1) query.set("candPage", String(all.candPage));
    if (all.discPage > 1) query.set("discPage", String(all.discPage));
    if (all.jobsPage > 1) query.set("jobsPage", String(all.jobsPage));
    const qs = query.toString();
    return `/admin/news${qs ? `?${qs}` : ""}${anchor}`;
  }

  const accepted = candidates.filter(
    (c) => (c.errors as unknown[]).length === 0,
  ).length;
  const selectedRunMeta = runs.find((r) => r.id === selectedRun);

  const stats = [
    {
      icon: Newspaper,
      label: "Publications",
      value: String(publications.length),
      hint: "Latest 100 · text or metadata",
    },
    {
      icon: ListChecks,
      label: "Selected run candidates",
      value: `${accepted}/${candidates.length}`,
      hint: selectedRun || "No run selected",
    },
    {
      icon: Layers,
      label: "Collection runs",
      value: String(runs.length),
      hint: "Latest 100 · news feeds & search",
    },
    {
      icon: Cpu,
      label: "Jobs needing attention",
      value: String(counts.pending + counts.retrying + counts.exhausted),
      hint: `Pending ${counts.pending} · Retrying ${counts.retrying} · Exhausted ${counts.exhausted}`,
    },
  ];

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900 antialiased">
      <header className="sticky top-0 z-10 border-b border-stone-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-4 px-6 py-5">
          <div>
            <p className="text-xs font-semibold tracking-[0.14em] text-emerald-900">
              NEWS INTELLIGENZ / LOCAL ADMIN
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">
              News collection
            </h1>
            <p className="mt-1 max-w-xl text-sm text-stone-500">
              News publications and the encounters that brought them here —
              feeds and search only. Parliamentary imports live under{" "}
              <a href="/admin/dip" className="underline underline-offset-4">
                DIP import runs
              </a>
              . Open a publication to read its extracted text or metadata-only
              fallback.
            </p>
          </div>
          <form
            action="/admin/news"
            method="GET"
            className="flex items-center gap-2"
          >
            <label htmlFor="run" className="text-xs font-medium text-stone-500">
              Run
            </label>
            <select
              id="run"
              name="run"
              defaultValue={selectedRun}
              className="h-9 max-w-72 rounded-md border border-input bg-background px-2 text-sm"
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" variant="secondary">
              Inspect
            </Button>
          </form>
        </div>
        <nav
          aria-label="Page sections"
          className="mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-6 pb-3 text-sm"
        >
          {[
            ["#publications", `Publications (${publications.length})`],
            ["#runs", `Runs (${runs.length})`],
            ["#candidates", `Candidates (${candidates.length})`],
            ["#jobs", `Jobs (${attention.length})`],
            ["/admin", "Overview"],
            ["/admin/dip", "DIP import runs"],
          ].map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="rounded-full px-3 py-1.5 whitespace-nowrap text-stone-600 transition-colors hover:bg-stone-200/70 hover:text-stone-900"
            >
              {label}
            </a>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-10 px-6 py-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-center gap-2 text-stone-500">
                <s.icon className="size-4" aria-hidden />
                <p className="text-xs font-medium">{s.label}</p>
              </div>
              <p className="mt-2 text-2xl font-semibold tabular-nums">
                {s.value}
              </p>
              <p
                className="mt-1 truncate text-xs text-stone-500"
                title={s.hint}
              >
                {s.hint}
              </p>
            </div>
          ))}
        </div>

        <section
          id="publications"
          aria-labelledby="pub-h"
          className="space-y-3"
        >
          <div>
            <h2 id="pub-h" className="text-xl font-semibold tracking-tight">
              Publications
            </h2>
            <p className="text-sm text-stone-500">
              Latest 100 · Original German/English text · All dates in UTC
            </p>
          </div>
          <TableCard
            label="Publications table"
            pager={
              <Pager
                page={pub.page}
                totalPages={pub.totalPages}
                from={pub.from}
                to={pub.to}
                total={pub.total}
                prevHref={hrefFor("pubPage", pub.page - 1, "#publications")}
                nextHref={hrefFor("pubPage", pub.page + 1, "#publications")}
              />
            }
          >
            <table className="w-full border-collapse text-left text-sm">
              <thead className="sticky top-0 bg-stone-50">
                <tr className="text-xs tracking-wide text-stone-500 uppercase">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Headline / original URL
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Publisher
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Published
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Content
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Encounters
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {pub.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center">
                      No publications yet. Run the collector to begin.
                    </td>
                  </tr>
                )}
                {pub.rows.map((p) => (
                  <tr key={p.id} className="align-top hover:bg-stone-50/70">
                    <td lang={p.language} className="max-w-md px-4 py-3">
                      <a
                        href={`/admin/publications/${p.id}`}
                        className="font-medium text-emerald-900 underline-offset-4 hover:underline"
                      >
                        {p.headline}
                      </a>
                      <span className="mt-0.5 block truncate text-xs text-stone-400">
                        {p.originalUrl}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {p.publisher}
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap tabular-nums text-stone-600">
                      {formatDate(p.publishedAt)}
                      <span className="block text-stone-400">
                        Found {formatDate(p.firstDiscoveredAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {p.contentAvailability === "full_text" ? (
                        <Badge variant="success">
                          Full text · v{p._count.versions}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Metadata only</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {p._count.discoveries}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableCard>
        </section>

        <section id="runs" aria-labelledby="runs-h" className="space-y-3">
          <div>
            <h2 id="runs-h" className="text-xl font-semibold tracking-tight">
              Collection runs
            </h2>
            <p className="text-sm text-stone-500">
              Latest 100 · Select a run to inspect its candidates and
              discoveries.
            </p>
          </div>
          <TableCard
            label="Collection runs table"
            pager={
              <Pager
                page={runList.page}
                totalPages={runList.totalPages}
                from={runList.from}
                to={runList.to}
                total={runList.total}
                prevHref={hrefFor("runsPage", runList.page - 1, "#runs")}
                nextHref={hrefFor("runsPage", runList.page + 1, "#runs")}
              />
            }
          >
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-stone-50">
                <tr className="text-xs tracking-wide text-stone-500 uppercase">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Run / feed
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Result
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Started
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Valid
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Invalid
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {runList.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center">
                      No runs yet.
                    </td>
                  </tr>
                )}
                {runList.rows.map((r) => (
                  <tr
                    key={r.id}
                    aria-current={r.id === selectedRun ? "true" : undefined}
                    className={cn(
                      "align-top hover:bg-stone-50/70",
                      r.id === selectedRun && "bg-emerald-900/[0.04]",
                    )}
                  >
                    <td className="px-4 py-3">
                      <a
                        href={`/admin/news?run=${encodeURIComponent(r.id)}#candidates`}
                        className="font-medium text-emerald-900 underline-offset-4 hover:underline"
                      >
                        {r.id}
                      </a>
                      <span className="block text-xs text-stone-400">
                        {r.feedId}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={runTone(r.status)}>{r.status}</Badge>
                      {r.error && (
                        <span className="mt-1 block max-w-56 truncate text-xs text-red-800">
                          {r.error}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap tabular-nums text-stone-600">
                      {formatDate(r.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {r.validCount}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {r.invalidCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableCard>
        </section>

        <section id="candidates" aria-labelledby="cand-h" className="space-y-3">
          <div>
            <h2 id="cand-h" className="text-xl font-semibold tracking-tight">
              Candidates
            </h2>
            <p className="text-sm text-stone-500">
              Run {selectedRunMeta?.id ?? "None"}
              {selectedRunMeta ? ` · ${selectedRunMeta.feedId}` : ""} · First
              100 entries · {accepted} accepted
            </p>
          </div>
          <TableCard
            label="Candidates table"
            pager={
              <Pager
                page={cand.page}
                totalPages={cand.totalPages}
                from={cand.from}
                to={cand.to}
                total={cand.total}
                prevHref={hrefFor("candPage", cand.page - 1, "#candidates")}
                nextHref={hrefFor("candPage", cand.page + 1, "#candidates")}
              />
            }
          >
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-stone-50">
                <tr className="text-xs tracking-wide text-stone-500 uppercase">
                  <th scope="col" className="w-14 px-4 py-3 font-medium">
                    <span aria-hidden="true">#</span>
                    <span className="sr-only">Row</span>
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Headline / metadata
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Validation
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {cand.rows.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center">
                      No candidates in this run.
                    </td>
                  </tr>
                )}
                {cand.rows.map((c) => {
                  const metadata = c.metadata as { headline?: unknown };
                  const errors = c.errors as unknown[];
                  return (
                    <tr
                      key={`${c.runId}:${c.itemIndex}`}
                      className="align-top hover:bg-stone-50/70"
                    >
                      <td className="px-4 py-3 tabular-nums text-stone-500">
                        {c.itemIndex + 1}
                      </td>
                      <td className="max-w-lg px-4 py-3">
                        <span className="font-medium">
                          {String(metadata.headline ?? "Unknown")}
                        </span>
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer text-emerald-900">
                            Retained metadata
                          </summary>
                          <pre className="mt-1 max-w-lg overflow-x-auto rounded-md bg-stone-100 p-2 whitespace-pre-wrap text-stone-600">
                            {JSON.stringify(c.metadata, null, 2)}
                          </pre>
                        </details>
                      </td>
                      <td className="px-4 py-3">
                        {errors.length ? (
                          <div className="space-y-1">
                            <Badge variant="destructive">Rejected</Badge>
                            <ul className="list-disc pl-4 text-xs text-red-800">
                              {errors.map((e, i) => (
                                <li key={i}>{String(e)}</li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <Badge variant="success">Accepted</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableCard>
          <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
            <div className="p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <History className="size-4" aria-hidden /> Discovery history for
                this run
              </h3>
              <p className="mt-0.5 text-xs text-stone-500">
                First 100 encounters; repeated items in one feed/run count once
                per publication.
              </p>
              {disc.rows.length === 0 ? (
                <p className="mt-2 text-sm text-stone-500">
                  No discoveries in this run.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-stone-100 text-sm">
                  {disc.rows.map((d) => (
                    <li
                      key={`${d.runId}:${d.publicationId}`}
                      className="flex flex-wrap justify-between gap-2 py-1.5"
                    >
                      <span className="font-medium">
                        {d.publication.headline}
                      </span>
                      <span className="text-xs whitespace-nowrap tabular-nums text-stone-500">
                        {d.run.feedId} · {formatDate(d.discoveredAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Pager
              page={disc.page}
              totalPages={disc.totalPages}
              from={disc.from}
              to={disc.to}
              total={disc.total}
              prevHref={hrefFor("discPage", disc.page - 1, "#candidates")}
              nextHref={hrefFor("discPage", disc.page + 1, "#candidates")}
            />
          </div>
        </section>

        <JobsTable
          jobs={jobs}
          prevHref={hrefFor("jobsPage", jobs.page - 1, "#jobs")}
          nextHref={hrefFor("jobsPage", jobs.page + 1, "#jobs")}
          tableLabel="Processing jobs table"
          blurb={
            <>
              News feeds and search only · Pending (incl. claimed):{" "}
              {counts.pending} · Retrying: {counts.retrying} · Exhausted:{" "}
              {counts.exhausted} · Retries resume automatically with backoff.
            </>
          }
          emptyLabel="No pending, retrying, or exhausted jobs."
        />

        <footer className="flex items-center gap-2 border-t border-stone-200 pt-4 text-xs text-stone-500">
          <ExternalLink className="size-3.5" aria-hidden />
          Local operator view · Refresh to see newly collected runs
        </footer>
      </main>
    </div>
  );
}
