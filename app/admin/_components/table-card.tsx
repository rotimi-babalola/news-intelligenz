import type { ReactNode } from "react";

export function formatDate(value: Date | null) {
  if (!value) return "Unknown";
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function runTone(status: string): "success" | "destructive" | "warning" {
  const s = status.toLowerCase();
  if (s.includes("fail") || s.includes("error")) return "destructive";
  if (s.includes("complete") || s.includes("success") || s === "ok")
    return "success";
  return "warning";
}

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
