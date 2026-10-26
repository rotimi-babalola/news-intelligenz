// Scheduled DIP collection runs at 07:00 Europe/Berlin, but Render cron
// schedules are UTC. Two UTC triggers plus an hour guard cover the DST shift
// without changing the schedule twice a year.
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
