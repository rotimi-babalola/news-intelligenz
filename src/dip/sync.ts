import type { PrismaClient } from "../generated/prisma/client";
import { collectSteps } from "./steps";
import type { FetchStepPage, FetchVorgang } from "./types";
import { collectVorgang } from "./vorgang";
import type { FetchVorgangPage } from "./vorgang";

// Fixed six-hour overlap from successful progress. An overlap window does not
// guarantee every delayed update is captured; it is a recovery policy.
export const SYNC_OVERLAP_MS = 6 * 60 * 60 * 1000;

export type SyncEndpoint = "/vorgang" | "/vorgangsposition";

export type SyncWindow = {
  start: Date | undefined;
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
  fetchPage: FetchVorgangPage & FetchStepPage;
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
  const checkpoint = await prisma.dipCheckpoint.findUnique({
    where: {
      endpoint_electoralTerm: {
        endpoint,
        electoralTerm: options.electoralTerm,
      },
    },
  });
  const window = resolveSyncWindow(checkpoint?.updatedThrough ?? null, now);
  const common = {
    runId: options.runId,
    electoralTerm: options.electoralTerm,
    updatedFrom: window.start,
    updatedTo: window.end,
    proceedingCap: options.proceedingCap,
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
          fetchPage: options.fetchPage,
          fetchVorgang: options.fetchVorgang,
        });
  return { window, result };
}
