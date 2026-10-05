// Pure display helpers for the admin inspection page.
// No JSX and no external imports so they stay unit-testable under
// tsconfig.node.json (which only compiles `.ts` sources).

export const PAGE_SIZE = 20;

// TODO: look into a universal date formatting library like `date-fns` or `luxon`
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

export function jobTone(
  status: string,
): "secondary" | "success" | "destructive" | "warning" {
  switch (status) {
    case "exhausted":
      return "destructive";
    case "retrying":
      return "warning";
    case "succeeded":
      return "success";
    default:
      return "secondary";
  }
}

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
