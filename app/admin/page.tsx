import {
  Landmark,
  Newspaper,
  TriangleAlert,
  Cpu,
  ArrowRight,
} from "lucide-react";
import { getAdminOverview } from "../../src/admin/service";
import { Badge } from "../../src/components/ui/badge";

export const dynamic = "force-dynamic";

export default async function AdminEntryPage() {
  const { newsRuns, dipRuns, publications, newsCounts, dipCounts, gaps } =
    await getAdminOverview();

  const newsJobs =
    newsCounts.pending + newsCounts.retrying + newsCounts.exhausted;
  const dipJobs = dipCounts.retrying + dipCounts.exhausted;

  const areas = [
    {
      href: "/admin/news",
      icon: Newspaper,
      title: "News imports",
      body: "Publications, feed and search runs, candidates, discoveries, and processing jobs — news sources only.",
      stats: [
        ["Runs", String(newsRuns)],
        ["Publications", String(publications)],
        ["Jobs needing attention", String(newsJobs)],
      ] as [string, string][],
    },
    {
      href: "/admin/dip",
      icon: Landmark,
      title: "DIP imports",
      body: "Parliamentary proceedings and steps with endpoint checkpoints and recovery gaps — DIP sources only.",
      stats: [
        ["Runs", String(dipRuns)],
        ["Unresolved gaps", String(gaps.length)],
        ["Jobs needing attention", String(dipJobs)],
      ] as [string, string][],
    },
  ];

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900 antialiased">
      <header className="border-b border-stone-200 bg-white/90 backdrop-blur">
        <div className="mx-auto max-w-[1400px] px-6 py-5">
          <p className="text-xs font-semibold tracking-[0.14em] text-emerald-900">
            NEWS INTELLIGENZ / LOCAL ADMIN
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Collection inspection
          </h1>
          <p className="mt-1 max-w-xl text-sm text-stone-500">
            Choose which imports to manage. News and parliamentary collection
            stay separate end to end.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-6 px-6 py-8">
        <div className="grid gap-3 md:grid-cols-2">
          {areas.map((a) => (
            <a
              key={a.href}
              href={a.href}
              className="group rounded-xl border border-stone-200 bg-white p-6 shadow-sm transition-colors hover:border-emerald-900/40"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <a.icon className="size-5 text-emerald-900" aria-hidden />
                  <h2 className="text-xl font-semibold tracking-tight">
                    {a.title}
                  </h2>
                </div>
                <ArrowRight
                  className="size-4 text-stone-400 transition-transform group-hover:translate-x-0.5 group-hover:text-emerald-900"
                  aria-hidden
                />
              </div>
              <p className="mt-2 text-sm text-stone-500">{a.body}</p>
              <dl className="mt-4 grid grid-cols-3 gap-2">
                {a.stats.map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-lg bg-stone-100 px-3 py-2"
                  >
                    <dt className="text-[11px] font-medium text-stone-500">
                      {label}
                    </dt>
                    <dd className="text-xl font-semibold tabular-nums">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </a>
          ))}
        </div>

        {(newsCounts.exhausted > 0 ||
          dipCounts.exhausted > 0 ||
          gaps.length > 0) && (
          <div
            role="status"
            aria-live="polite"
            className="flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm shadow-sm"
          >
            <TriangleAlert className="size-4 text-red-800" aria-hidden />
            <span className="font-medium">Needs attention:</span>
            {newsCounts.exhausted > 0 && (
              <Badge variant="destructive">
                News · {newsCounts.exhausted} exhausted
              </Badge>
            )}
            {dipCounts.exhausted > 0 && (
              <Badge variant="destructive">
                DIP · {dipCounts.exhausted} exhausted
              </Badge>
            )}
            {gaps.length > 0 && (
              <Badge variant="warning">
                DIP · {gaps.length} unresolved{" "}
                {gaps.length === 1 ? "gap" : "gaps"}
              </Badge>
            )}
            <span className="flex items-center gap-1 text-xs text-stone-500">
              <Cpu className="size-3.5" aria-hidden />
              News pending {newsCounts.pending} · retrying {newsCounts.retrying}
              {" · "}DIP {dipCounts.pending} queued downstream · retrying{" "}
              {dipCounts.retrying}
            </span>
          </div>
        )}
      </main>
    </div>
  );
}
