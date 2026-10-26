import type { PrismaClient } from "../generated/prisma/client";
import { findDipCheckpoint } from "./repository";
import { collectSteps } from "./steps";
import type { FetchStepPage, FetchVorgang } from "./types";
import { collectVorgang } from "./vorgang";
import type { FetchVorgangPage } from "./vorgang";

// Fixed six-hour overlap from successful progress. An overlap window does not
// guarantee every delayed update is captured; it is a recovery policy.
export const SYNC_OVERLAP_MS = 6 * 60 * 60 * 1000;

export type SyncEndpoint = "/vorgang" | "/vorgangsposition";

export type SyncWindow = {
  start?: Date | undefined;
  end: Date;
};

// Baseline (no checkpoint) imports without an aktualisiert start filter; later
// scans start six hours before successful progress and end at the fixed now.
export function resolveSyncWindow(
  updatedThrough: Date | null,
  now: Date,
): SyncWindow {
  if (!updatedThrough) return { start: undefined, end: new Date(now) };
  return {
    start: new Date(updatedThrough.getTime() - SYNC_OVERLAP_MS),
    end: new Date(now),
  };
}

export type SyncDipEndpointOptions = {
  runId: string;
  electoralTerm: number;
  now?: Date;
  proceedingCap?: number;
  followStoredParents?: boolean;
  scopeToStoredProceedings?: boolean;
  retryDelayMs?: (attempt: number, error: unknown) => number;
  // Operator-selected recovery/backfill window, used verbatim instead of the
  // checkpoint-derived window. The checkpoint still only moves forward.
  window?: { start?: Date; end: Date };
  fetchPage: FetchVorgangPage | FetchStepPage;
  fetchVorgang?: FetchVorgang;
};

// Single endpoint/term incremental scan. Reads the durable checkpoint,
// derives the fixed window, and delegates to the existing page collector,
// which advances the checkpoint only after all pages are durably stored.
// Callers pass Date objects; fetchers send explicit-offset ISO strings.
export async function syncDipEndpoint(
  prisma: PrismaClient,
  endpoint: SyncEndpoint,
  options: SyncDipEndpointOptions,
) {
  const now = options.now ?? new Date();
  const checkpoint = await findDipCheckpoint(
    prisma,
    endpoint,
    options.electoralTerm,
  );
  const window =
    options.window ??
    resolveSyncWindow(checkpoint?.updatedThrough ?? null, now);
  const common = {
    runId: options.runId,
    electoralTerm: options.electoralTerm,
    updatedFrom: window.start,
    updatedTo: window.end,
    proceedingCap: options.proceedingCap,
    retryDelayMs: options.retryDelayMs,
  };
  const result =
    endpoint === "/vorgang"
      ? await collectVorgang(prisma, {
          ...common,
          fetchPage: options.fetchPage,
        })
      : await collectSteps(prisma, {
          ...common,
          now,
          followStoredParents: options.followStoredParents,
          scopeToStoredProceedings: options.scopeToStoredProceedings,
          fetchPage: options.fetchPage,
          fetchVorgang: options.fetchVorgang,
        });
  return { window, result };
}

export type TermSyncCompleted = {
  endpoint: SyncEndpoint;
  electoralTerm: number;
  window: SyncWindow;
  result:
    | Awaited<ReturnType<typeof collectVorgang>>
    | Awaited<ReturnType<typeof collectSteps>>;
};

export type TermSyncFailure = {
  endpoint: SyncEndpoint;
  electoralTerm: number;
  error: string;
};

export type TermsSyncOutcome = {
  completed: TermSyncCompleted[];
  failed: TermSyncFailure[];
};

export type SyncDipTermsOptions = {
  // Explicit term list only; historical terms are never auto-imported. A term
  // without a checkpoint gets a baseline import, the rest get overlap scans.
  terms: number[];
  endpoints?: SyncEndpoint[];
  runIdFor: (endpoint: SyncEndpoint, electoralTerm: number) => string;
  now?: Date;
  proceedingCap?: number;
  followStoredParents?: boolean;
  scopeToStoredProceedings?: boolean;
  retryDelayMs?: (attempt: number, error: unknown) => number;
  // Operator-selected recovery/backfill window applied to every listed scope.
  window?: SyncWindow;
  fetchVorgangPage: FetchVorgangPage;
  fetchStepPage: FetchStepPage;
  fetchVorgang?: FetchVorgang;
};

// Multi-term scan. Every listed scope is attempted even when a sibling fails;
// failures are reported per scope so one broken term never blocks the rest.
export async function syncDipTerms(
  prisma: PrismaClient,
  options: SyncDipTermsOptions,
): Promise<TermsSyncOutcome> {
  const endpoints =
    options.endpoints ?? (["/vorgang", "/vorgangsposition"] as SyncEndpoint[]);
  const now = options.now ?? new Date();
  const outcome: TermsSyncOutcome = { completed: [], failed: [] };
  for (const electoralTerm of [...new Set(options.terms)]) {
    for (const endpoint of endpoints) {
      try {
        const { window, result } = await syncDipEndpoint(prisma, endpoint, {
          runId: options.runIdFor(endpoint, electoralTerm),
          electoralTerm,
          now,
          proceedingCap: options.proceedingCap,
          followStoredParents: options.followStoredParents,
          scopeToStoredProceedings: options.scopeToStoredProceedings,
          retryDelayMs: options.retryDelayMs,
          window: options.window,
          fetchPage:
            endpoint === "/vorgang"
              ? options.fetchVorgangPage
              : options.fetchStepPage,
          fetchVorgang: options.fetchVorgang,
        });
        outcome.completed.push({ endpoint, electoralTerm, window, result });
      } catch (error) {
        outcome.failed.push({
          endpoint,
          electoralTerm,
          error:
            error instanceof Error ? error.message.slice(0, 2000) : "unknown",
        });
      }
    }
  }
  return outcome;
}
