import { ChevronLeft, ChevronRight } from "lucide-react";

export const PAGE_SIZE = 20;

export function parsePage(raw?: string | string[]): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export type Page<T> = {
  rows: T[];
  page: number;
  totalPages: number;
  from: number;
  to: number;
  total: number;
};

export function paginate<T>(items: T[], page: number): Page<T> {
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

export function Pager({
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
