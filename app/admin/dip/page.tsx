import { Cpu, Landmark, ListChecks, Layers } from "lucide-react";
import { getDipOverview } from "../../../src/admin/service";
import { Badge } from "../../../src/components/ui/badge";
import { Button } from "../../../src/components/ui/button";
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

function scopeLabel(scope: unknown): string {
  if (typeof scope !== "object" || scope === null) return "";
  const s = scope as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof s["electoralTerm"] === "number")
    parts.push(`WP ${s["electoralTerm"]}`);
  if (
    typeof s["aktualisiertStart"] === "string" ||
    typeof s["aktualisiertEnd"] === "string"
  )
    parts.push(
      `${String(s["aktualisiertStart"] ?? "…")} → ${String(s["aktualisiertEnd"] ?? "…")}`,
    );
  return parts.join(" · ");
}

export default async function DipAdminPage({
  searchParams,
}: {
  searchParams?: Promise<{
    run?: string;
    runsPage?: string;
    candPage?: string;
    jobsPage?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};
  const {
    runs,
    selectedRun,
    candidates,
    discoveries,
    checkpoints,
    gaps,
    counts,
    attention,
  } = await getDipOverview(params.run);

  const runsPage = parsePage(params.runsPage);
  const candPage = parsePage(params.candPage);
  const jobsPage = parsePage(params.jobsPage);
  const runList = paginate(runs, runsPage);
  const cand = paginate(candidates, candPage);
  const jobs = paginate(attention, jobsPage);
  const accepted = candidates.filter((c) => c.errors.length === 0).length;
  const selectedRunMeta = runs.find((r) => r.id === selectedRun);

  function hrefFor(
    key: "runsPage" | "candPage" | "jobsPage",
    value: number,
    anchor: string,
  ): string {
    const query = new URLSearchParams();
    if (selectedRun) query.set("run", selectedRun);
    const all = {
      runsPage: key === "runsPage" ? value : runList.page,
      candPage: key === "candPage" ? value : cand.page,
      jobsPage: key === "jobsPage" ? value : jobs.page,
    };
    if (all.runsPage > 1) query.set("runsPage", String(all.runsPage));
    if (all.candPage > 1) query.set("candPage", String(all.candPage));
    if (all.jobsPage > 1) query.set("jobsPage", String(all.jobsPage));
    const qs = query.toString();
    return `/admin/dip${qs ? `?${qs}` : ""}${anchor}`;
  }

  const stats = [
    {
      icon: Layers,
      label: "DIP runs",
      value: String(runs.length),
      hint: "Latest 100 · dip_endpoint",
    },
    {
      icon: ListChecks,
      label: "Selected run candidates",
      value: `${accepted}/${candidates.length}`,
      hint: selectedRun || "No run selected",
    },
    {
      icon: Landmark,
      label: "Checkpoints",
      value: String(checkpoints.length),
      hint: `Per endpoint / term · ${gaps.length} unresolved gaps`,
    },
    {
      icon: Cpu,
      label: "Jobs needing attention",
      value: String(counts.retrying + counts.exhausted),
      hint: `Retrying ${counts.retrying} · Exhausted ${counts.exhausted} · ${counts.pending} queued downstream`,
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
              DIP import runs
            </h1>
            <p className="mt-1 max-w-xl text-sm text-stone-500">
              Parliamentary proceedings and steps, kept separate from news
              publications. Candidates resolve to stored proceeding/step titles
              — never news headlines.
            </p>
          </div>
          <form
            action="/admin/dip"
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
            ["/admin", "Overview"],
            ["/admin/news", "News imports"],
            ["#runs", `Runs (${runs.length})`],
            ["#candidates", `Candidates (${candidates.length})`],
            ["#jobs", `Jobs (${attention.length})`],
            ["#progress", `Checkpoints (${checkpoints.length})`],
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

        <section id="runs" aria-labelledby="runs-h" className="space-y-3">
          <div>
            <h2 id="runs-h" className="text-xl font-semibold tracking-tight">
              DIP runs
            </h2>
            <p className="text-sm text-stone-500">
              Latest 100 · endpoint + electoral-term scope · window from
              sourceScope.
            </p>
          </div>
          <TableCard
            label="DIP runs table"
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
                    Run / endpoint
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
                      No DIP runs yet.
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
                        href={`/admin/dip?run=${encodeURIComponent(r.id)}#candidates`}
                        className="font-medium text-emerald-900 underline-offset-4 hover:underline"
                      >
                        {r.id}
                      </a>
                      <span className="block text-xs text-stone-400">
                        {r.feedId} · {scopeLabel(r.sourceScope)}
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
              {selectedRunMeta
                ? ` · ${selectedRunMeta.feedId} · ${scopeLabel(selectedRunMeta.sourceScope)}`
                : ""}{" "}
              · First 100 entries · {accepted} accepted
            </p>
          </div>
          <TableCard
            label="DIP candidates table"
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
                    Record
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
                {cand.rows.map((c) => (
                  <tr
                    key={`${c.runId}:${c.itemIndex}`}
                    className="align-top hover:bg-stone-50/70"
                  >
                    <td className="px-4 py-3 tabular-nums text-stone-500">
                      {c.itemIndex + 1}
                    </td>
                    <td className="max-w-lg px-4 py-3">
                      <span className="font-medium">{c.title}</span>
                      <span className="mt-0.5 block text-xs text-stone-500">
                        {c.subtitle}
                      </span>
                      <span className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="secondary">
                          {c.endpoint || "no endpoint"}
                        </Badge>
                        {c.apiId && (
                          <Badge variant="secondary">ID {c.apiId}</Badge>
                        )}
                        <Badge variant="secondary">{c.kind}</Badge>
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
                      {c.errors.length ? (
                        <div className="space-y-1">
                          <Badge variant="destructive">Rejected</Badge>
                          <ul className="list-disc pl-4 text-xs text-red-800">
                            {c.errors.map((e, i) => (
                              <li key={i}>{String(e)}</li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <Badge variant="success">Accepted</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableCard>

          <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
            <div className="p-4">
              <h3 className="text-sm font-semibold">
                Parliamentary discoveries for this run
              </h3>
              <p className="mt-0.5 text-xs text-stone-500">
                First 100 encounters · entity + API ID · titles from stored
                records.
              </p>
              {discoveries.length === 0 ? (
                <p className="mt-2 text-sm text-stone-500">
                  No parliamentary discoveries in this run.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-stone-100 text-sm">
                  {discoveries.slice(0, 100).map((d) => (
                    <li
                      key={`${d.runId}:${d.entity}:${d.apiId}`}
                      className="flex flex-wrap justify-between gap-2 py-1.5"
                    >
                      <span className="font-medium">{d.title}</span>
                      <span className="text-xs whitespace-nowrap tabular-nums text-stone-500">
                        {d.entity} · {d.apiId} · {formatDate(d.discoveredAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        <JobsTable
          jobs={jobs}
          prevHref={hrefFor("jobsPage", jobs.page - 1, "#jobs")}
          nextHref={hrefFor("jobsPage", jobs.page + 1, "#jobs")}
          tableLabel="DIP processing jobs table"
          blurb={
            <>
              DIP endpoints only · Retrying: {counts.retrying} · Exhausted:{" "}
              {counts.exhausted} · {counts.pending} pending embedding/document
              jobs are queued downstream work, not failures — they drain once
              the retrieval and PDF workers land. Retries resume automatically
              with backoff.
            </>
          }
          emptyLabel="No pending, retrying, or exhausted DIP jobs."
        />

        <section id="progress" aria-labelledby="prog-h" className="space-y-3">
          <div>
            <h2 id="prog-h" className="text-xl font-semibold tracking-tight">
              Checkpoints & gaps
            </h2>
            <p className="mt-0.5 text-xs text-stone-500">
              Checkpoint advances only after all pages of a window are stored.
              Gaps are failed windows not yet covered by success.
            </p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <TableCard label="DIP checkpoints table">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-stone-50">
                  <tr className="text-xs tracking-wide text-stone-500 uppercase">
                    <th scope="col" className="px-4 py-3 font-medium">
                      Endpoint / term
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Updated through
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {checkpoints.length === 0 && (
                    <tr>
                      <td colSpan={2} className="px-4 py-8 text-center">
                        No checkpoints yet.
                      </td>
                    </tr>
                  )}
                  {checkpoints.map((c) => (
                    <tr
                      key={`${c.endpoint}:${c.electoralTerm}`}
                      className="align-top hover:bg-stone-50/70"
                    >
                      <td className="px-4 py-3 font-medium">
                        {c.endpoint} · WP {c.electoralTerm}
                      </td>
                      <td className="px-4 py-3 text-xs tabular-nums text-stone-600">
                        {formatDate(c.updatedThrough)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>
            <TableCard label="DIP gaps table">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-stone-50">
                  <tr className="text-xs tracking-wide text-stone-500 uppercase">
                    <th scope="col" className="px-4 py-3 font-medium">
                      Failed window
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Error
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {gaps.length === 0 && (
                    <tr>
                      <td colSpan={2} className="px-4 py-8 text-center">
                        No unresolved gaps.
                      </td>
                    </tr>
                  )}
                  {gaps.map((g) => (
                    <tr
                      key={g.runId}
                      className="align-top hover:bg-stone-50/70"
                    >
                      <td className="px-4 py-3">
                        <span className="font-medium">
                          {g.endpoint} ·{" "}
                          {g.electoralTerm === null
                            ? "no term"
                            : `WP ${g.electoralTerm}`}
                        </span>
                        <span className="block text-xs tabular-nums text-stone-500">
                          {g.runId} · {formatDate(g.windowStart)} →{" "}
                          {formatDate(g.windowEnd)}
                        </span>
                      </td>
                      <td className="max-w-xs px-4 py-3 text-xs text-red-800">
                        {g.error ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>
          </div>
        </section>
      </main>
    </div>
  );
}
