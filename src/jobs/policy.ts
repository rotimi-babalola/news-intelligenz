export const MAX_ATTEMPTS_DEFAULT = 5;
export const LEASE_MS_DEFAULT = 5 * 60 * 1000;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

export function backoffMs(attempts: number): number {
  return Math.min(
    BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
    BACKOFF_CAP_MS,
  );
}

export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  return null;
}

export class RateLimitedError extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs = 60_000) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}
