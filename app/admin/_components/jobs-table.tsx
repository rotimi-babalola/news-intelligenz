import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import type { ProcessingJob } from "@/src/generated/prisma/client";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { retryJobAction } from "../actions";
import { Pager } from "./pager";
import { TableCard } from "./table-card";
import { formatDate, jobTone, type Page } from "./display";

// Shared processing-jobs section for the news and DIP admin pages. Only the
// copy differs per area; the table, retry action, and pagination stay common
// so the two pages cannot drift apart again.
export function JobsTable({
  jobs,
  prevHref,
  nextHref,
  tableLabel,
  blurb,
  emptyLabel,
}: {
  jobs: Page<ProcessingJob>;
  prevHref: string;
  nextHref: string;
  tableLabel: string;
  blurb: ReactNode;
  emptyLabel: string;
}) {
  return (
    <section id="jobs" aria-labelledby="jobs-h" className="space-y-3">
      <div>
        <h2 id="jobs-h" className="text-xl font-semibold tracking-tight">
          Processing jobs
        </h2>
        <p className="text-sm text-stone-500">{blurb}</p>
      </div>
      <TableCard
        label={tableLabel}
        pager={
          <Pager
            page={jobs.page}
            totalPages={jobs.totalPages}
            from={jobs.from}
            to={jobs.to}
            total={jobs.total}
            prevHref={prevHref}
            nextHref={nextHref}
          />
        }
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
                  {emptyLabel}
                </td>
              </tr>
            )}
            {jobs.rows.map((j) => (
              <tr key={j.id} className="align-top hover:bg-stone-50/70">
                <td className="px-4 py-3">
                  <span className="font-medium">{j.sourceKey}</span>
                  <span className="block text-xs text-stone-400">
                    {j.operation} · {j.sourceKind} · Run {j.runId}
                    {j.itemIndex === null ? "" : ` · Item ${j.itemIndex + 1}`}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <Badge variant={jobTone(j.status)}>{j.status}</Badge>
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
      </TableCard>
    </section>
  );
}
