// Scheduled DIP collection runs at 07:00 Europe/Berlin, but Render cron
// schedules are UTC. Trigger at 05:00 and 06:00 UTC; the hour guard lets only
// the trigger that lands on 07:00 Berlin collect, so DST needs no change.
export const DEFAULT_ELECTORAL_TERMS = [21, 20];

// "21,20" -> [21, 20]. The DIP API accepts terms 1-30; the order given is kept
// because terms are collected independently and a later term need not wait.
export function parseElectoralTerms(raw: string | undefined): number[] {
  if (!raw?.trim()) return [...DEFAULT_ELECTORAL_TERMS];
  const terms = raw.split(",").map((part) => Number(part.trim()));
  if (terms.some((term) => !Number.isInteger(term) || term < 1 || term > 30))
    throw new Error(
      `DIP_ELECTORAL_TERMS must be electoral terms 1-30 separated by commas, got "${raw}"`,
    );
  return [...new Set(terms)];
}

export function berlinHour(now: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
}

// DIP_RUN_HOUR is the Berlin hour to collect at. Empty means every trigger
// collects; anything else must be a full hour, so a typo fails instead of
// silently skipping every run.
export function parseRunHour(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) return null;
  const hour = Number(value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23)
    throw new Error(`DIP_RUN_HOUR must be an hour 0-23, got "${raw}"`);
  return hour;
}

export function isDue(now: Date, runHour: number | null): boolean {
  return runHour === null || berlinHour(now) === runHour;
}

// Unique per invocation, so a retry never replays the previous run and the
// checkpoint, not the run id, decides what still needs collecting.
export function defaultRunId(now: Date): string {
  return `dip-${now.toISOString().replace(/[-:.]/g, "")}`;
}

export type BackfillWindow = { start?: Date; end: Date };

// Operator-selected window for a missed or failed period. DIP_BACKFILL_FROM /
// DIP_BACKFILL_TO accept anything Date.parse handles; an omitted end means now.
export function parseBackfillWindow(
  from: string | undefined,
  to: string | undefined,
  now = new Date(),
): BackfillWindow | undefined {
  const startRaw = from?.trim();
  const endRaw = to?.trim();
  if (!startRaw && !endRaw) return undefined;
  const start = startRaw ? parseDate(startRaw, "DIP_BACKFILL_FROM") : undefined;
  const end = endRaw ? parseDate(endRaw, "DIP_BACKFILL_TO") : now;
  if (start && start >= end)
    throw new Error("DIP_BACKFILL_FROM must be before DIP_BACKFILL_TO");
  return { start, end };
}

function parseDate(raw: string, name: string): Date {
  const value = new Date(raw);
  if (Number.isNaN(value.getTime()))
    throw new Error(`${name} must be a valid date, got "${raw}"`);
  return value;
}

// Unset means no cap, matching the deployed collector. A set value must be a
// positive integer so a typo never caps collection at zero.
export function parseProceedingCap(
  raw: string | undefined,
): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const cap = Number(value);
  if (!Number.isInteger(cap) || cap < 1)
    throw new Error(
      `DIP_PROCEEDING_CAP must be a positive integer, got "${raw}"`,
    );
  return cap;
}
