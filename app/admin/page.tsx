import {
  ChevronLeft,
  ChevronRight,
  Cpu,
  ExternalLink,
  History,
  Layers,
  ListChecks,
  Newspaper,
  RotateCcw,
} from "lucide-react";
import { getAdminOverview } from "../../src/admin/service";
import { Button } from "../../src/components/ui/button";
import { cn } from "../../src/lib/utils";
import { retryJobAction } from "./actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

function formatDate(value: Date | null) {
  if (!value) return "Unknown";
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function pill(tone: "ok" | "bad" | "warn" | "mute", label: string) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        tone === "ok" &&
          "border-emerald-900/20 bg-emerald-900/10 text-emerald-900",
        tone === "bad" && "border-red-800/20 bg-red-50 text-red-800",
        tone === "warn" && "border-amber-700/30 bg-amber-50 text-amber-800",
        tone === "mute" && "border-border bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function runTone(status: string): "ok" | "bad" | "warn" {
  const s = status.toLowerCase();
  if (s.includes("fail") || s.includes("error")) return "bad";
  if (s.includes("complete") || s.includes("success") || s === "ok")
    return "ok";
  return "warn";
}

function parsePage(raw?: string | string[]): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function paginate<T>(items: T[], page: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safe = Math.min(Math.max(page, 1), totalPages);
  const start = (safe - 1) * PAGE_SIZE;
  return {
    rows: items.slice(start, start + PAGE_SIZE),
    page: safe,
    totalPages,
    from: items.length === 0 ? 0 : start + 1,
    to: Math.min(start + PAGE_SIZE, items.length),
    total: items.length,
  };
}

function Pager({
  page,
  totalPages,
  from,
  to,
  total,
  prevHref,
  nextHref,
}: {
  page: number;
  totalPages: number;
  from: number;
  to: number;
  total: number;
  prevHref: string;
  nextHref: string;
}) {
  if (totalPages <= 1) return null;
  const linkClass =
    "inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-stone-700 transition-colors hover:bg-stone-200/70 hover:text-stone-900";
  const disabledClass =
    "inline-flex items-center gap-1 rounded-md px-2 py-1 text-stone-300";
  return (
    <div className="flex items-center justify-between gap-3 border-t border-stone-100 px-4 py-2.5 text-xs text-stone-500">
      <p aria-live="polite" className="tabular-nums">
        Showing {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-1">
        {page > 1 ? (
          <a href={prevHref} aria-label="Previous page" className={linkClass}>
            <ChevronLeft className="size-3.5" aria-hidden />
            Prev
          </a>
        ) : (
          <span aria-disabled="true" className={disabledClass}>
            <ChevronLeft className="size-3.5" aria-hidden />
            Prev
          </span>
        )}
        <span className="px-1 tabular-nums">
          Page {page} of {totalPages}
        </span>
        {page < totalPages ? (
          <a href={nextHref} aria-label="Next page" className={linkClass}>
            Next
            <ChevronRight className="size-3.5" aria-hidden />
          </a>
        ) : (
          <span aria-disabled="true" className={disabledClass}>
            Next
            <ChevronRight className="size-3.5" aria-hidden />
          </span>
        )}
      </div>
    </div>
  );
}

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
  } = await getAdminOverview(params.run);

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
    return `/admin${qs ? `?${qs}` : ""}${anchor}`;
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
      hint: "Latest 100 · metadata only",
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
      hint: "Latest 100",
    },
    {
      icon: Cpu,
      label: "Jobs needing attention",
      value: String(attention.length),
      hint: `Pending ${counts.pending} · Exhausted ${counts.exhausted}`,
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
              Collection inspection
            </h1>
            <p className="mt-1 max-w-xl text-sm text-stone-500">
              Single-operator view of publications and the encounters that
              brought them here. Nine public-news feeds; article text is never
              retained.
            </p>
          </div>
          <form
            action="/admin"
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
          <div className="rounded-xl border border-stone-200 bg-white shadow-sm">
            <div
              className="overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label="Publications table"
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
                    <th
                      scope="col"
                      className="px-4 py-3 text-right font-medium"
                    >
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
                          href={p.originalUrl}
                          rel="noreferrer"
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
                        {pill("mute", "Metadata only")}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {p._count.discoveries}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              page={pub.page}
              totalPages={pub.totalPages}
              from={pub.from}
              to={pub.to}
              total={pub.total}
              prevHref={hrefFor("pubPage", pub.page - 1, "#publications")}
              nextHref={hrefFor("pubPage", pub.page + 1, "#publications")}
            />
          </div>
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
          <div className="rounded-xl border border-stone-200 bg-white shadow-sm">
            <div
              className="overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label="Collection runs table"
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
                    <th
                      scope="col"
                      className="px-4 py-3 text-right font-medium"
                    >
                      Valid
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-right font-medium"
                    >
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
                          href={`/admin?run=${encodeURIComponent(r.id)}#candidates`}
                          className="font-medium text-emerald-900 underline-offset-4 hover:underline"
                        >
                          {r.id}
                        </a>
                        <span className="block text-xs text-stone-400">
                          {r.feedId}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {pill(runTone(r.status), r.status)}
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
            </div>
            <Pager
              page={runList.page}
              totalPages={runList.totalPages}
              from={runList.from}
              to={runList.to}
              total={runList.total}
              prevHref={hrefFor("runsPage", runList.page - 1, "#runs")}
              nextHref={hrefFor("runsPage", runList.page + 1, "#runs")}
            />
          </div>
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
          <div className="rounded-xl border border-stone-200 bg-white shadow-sm">
            <div
              className="overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label="Candidates table"
            >
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-stone-50">
                  <tr className="text-xs tracking-wide text-stone-500 uppercase">
                    <th scope="col" className="w-14 px-4 py-3 font-medium">
                      #
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
                              {pill("bad", "Rejected")}
                              <ul className="list-disc pl-4 text-xs text-red-800">
                                {errors.map((e, i) => (
                                  <li key={i}>{String(e)}</li>
                                ))}
                              </ul>
                            </div>
                          ) : (
                            pill("ok", "Accepted")
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager
              page={cand.page}
              totalPages={cand.totalPages}
              from={cand.from}
              to={cand.to}
              total={cand.total}
              prevHref={hrefFor("candPage", cand.page - 1, "#candidates")}
              nextHref={hrefFor("candPage", cand.page + 1, "#candidates")}
            />
          </div>
          <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
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
            {disc.totalPages > 1 && (
              <div className="-mx-4 -mb-4 mt-2">
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
            )}
          </div>
        </section>

        <section id="jobs" aria-labelledby="jobs-h" className="space-y-3">
          <div>
            <h2 id="jobs-h" className="text-xl font-semibold tracking-tight">
              Processing jobs
            </h2>
            <p className="text-sm text-stone-500">
              Pending (incl. claimed): {counts.pending} · Retrying:{" "}
              {counts.retrying} · Exhausted: {counts.exhausted} · Retries resume
              automatically with backoff.
            </p>
          </div>
          <div className="rounded-xl border border-stone-200 bg-white shadow-sm">
            <div
              className="overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label="Processing jobs table"
            >
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-stone-50">
                  <tr className="text-xs tracking-wide text-stone-500 uppercase">
                    <th scope="col" className="px-4 py-3 font-medium">
                      Source / run
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      State
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Last error
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {jobs.rows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center">
                        No retrying or exhausted jobs.
                      </td>
                    </tr>
                  )}
                  {jobs.rows.map((j) => (
                    <tr key={j.id} className="align-top hover:bg-stone-50/70">
                      <td className="px-4 py-3">
                        <span className="font-medium">{j.sourceKey}</span>
                        <span className="block text-xs text-stone-400">
                          {j.sourceKind} · Run {j.runId}
                          {j.itemIndex === null
                            ? ""
                            : ` · Item ${j.itemIndex + 1}`}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {pill(
                          j.status === "exhausted" ? "bad" : "warn",
                          j.status,
                        )}
                        <span className="mt-1 block text-xs whitespace-nowrap tabular-nums text-stone-500">
                          Attempt {j.attempts}/{j.maxAttempts} · Next{" "}
                          {formatDate(j.nextAttemptAt)}
                        </span>
                      </td>
                      <td className="max-w-xs px-4 py-3 text-xs text-stone-600">
                        {j.lastError ?? ""}
                      </td>
                      <td className="px-4 py-3">
                        {j.status === "exhausted" && (
                          <form action={retryJobAction}>
                            <input type="hidden" name="id" value={j.id} />
                            <Button
                              type="submit"
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                            >
                              <RotateCcw className="size-3.5" aria-hidden />
                              Retry
                            </Button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              page={jobs.page}
              totalPages={jobs.totalPages}
              from={jobs.from}
              to={jobs.to}
              total={jobs.total}
              prevHref={hrefFor("jobsPage", jobs.page - 1, "#jobs")}
              nextHref={hrefFor("jobsPage", jobs.page + 1, "#jobs")}
            />
          </div>
        </section>

        <footer className="flex items-center gap-2 border-t border-stone-200 pt-4 text-xs text-stone-500">
          <ExternalLink className="size-3.5" aria-hidden />
          Local operator view · Refresh to see newly collected runs
        </footer>
      </main>
    </div>
  );
}
