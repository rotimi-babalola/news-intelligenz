import type { ReactNode } from "react";

export function TableCard({
  label,
  children,
  pager,
}: {
  label: string;
  children: ReactNode;
  pager?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white shadow-sm">
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label={label}
      >
        {children}
      </div>
      {pager}
    </div>
  );
}
