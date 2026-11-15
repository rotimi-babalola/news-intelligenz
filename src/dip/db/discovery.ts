import type {
  ParliamentaryEntity,
  Prisma,
} from "../../generated/prisma/client";
import type { Client } from "./client";

export function upsertDipCandidate(
  client: Client,
  runId: string,
  itemIndex: number,
  metadata: Prisma.InputJsonValue,
  errors: string[],
) {
  return client.candidate.upsert({
    where: { runId_itemIndex: { runId, itemIndex } },
    create: { runId, itemIndex, metadata, errors },
    update: { metadata, errors },
  });
}

export function upsertParliamentaryDiscovery(
  client: Client,
  runId: string,
  entity: ParliamentaryEntity,
  apiId: string,
) {
  return client.parliamentaryDiscovery.upsert({
    where: { runId_entity_apiId: { runId, entity, apiId } },
    create: { runId, entity, apiId },
    update: {},
  });
}

export function findDipCheckpoint(
  client: Client,
  endpoint: string,
  electoralTerm: number,
) {
  return client.dipCheckpoint.findUnique({
    where: { endpoint_electoralTerm: { endpoint, electoralTerm } },
  });
}

// A failed window remains a gap until a successful window for the same scope
// covers it. Run history stays intact after recovery.
export type DipGap = {
  runId: string;
  endpoint: string;
  electoralTerm: number | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  error: string | null;
  startedAt: Date;
};

function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function scopeKey(endpoint: string, scope: Record<string, unknown>) {
  return JSON.stringify([
    endpoint,
    scope["electoralTerm"],
    scope["proceedingCap"] ?? null,
    scope["followStoredParents"] ?? false,
  ]);
}

export async function listDipGaps(
  client: Client,
  limit = 50,
): Promise<DipGap[]> {
  const runs = await client.run.findMany({
    where: { sourceKind: "dip_endpoint", status: "failed" },
    orderBy: { startedAt: "desc" },
  });
  if (runs.length === 0) return [];
  const failures = runs.map((run) => {
    const scope = (run.sourceScope ?? {}) as Record<string, unknown>;
    return {
      runId: run.id,
      endpoint: run.feedId,
      electoralTerm:
        typeof scope["electoralTerm"] === "number"
          ? scope["electoralTerm"]
          : null,
      windowStart: asDate(scope["aktualisiertStart"]),
      windowEnd: asDate(scope["aktualisiertEnd"]),
      error: run.error,
      startedAt: run.startedAt,
      scopeKey: scopeKey(run.feedId, scope),
    };
  });
  // shortcut: inspect DIP run history in memory; add indexed recovery state
  // when the number of completed windows makes this admin query expensive.
  const completed = await client.run.findMany({
    where: {
      sourceKind: "dip_endpoint",
      status: "completed",
      feedId: { in: [...new Set(failures.map((gap) => gap.endpoint))] },
    },
    select: { feedId: true, sourceScope: true },
  });
  const windows = new Map<string, { start: Date | null; end: Date | null }[]>();
  for (const run of completed) {
    const scope = (run.sourceScope ?? {}) as Record<string, unknown>;
    const key = scopeKey(run.feedId, scope);
    const window = {
      start: asDate(scope["aktualisiertStart"]),
      end: asDate(scope["aktualisiertEnd"]),
    };
    const scoped = windows.get(key) ?? [];
    scoped.push(window);
    windows.set(key, scoped);
  }
  return failures
    .filter((gap) => {
      const successes = windows.get(gap.scopeKey) ?? [];
      return !successes.some(
        (success) =>
          gap.windowEnd &&
          success.end &&
          success.end >= gap.windowEnd &&
          (success.start === null ||
            (gap.windowStart !== null && success.start <= gap.windowStart)),
      );
    })
    .slice(0, limit)
    .map(({ scopeKey: _scopeKey, ...gap }) => gap);
}

export function upsertDipCheckpoint(
  client: Client,
  endpoint: string,
  electoralTerm: number,
  updatedThrough: Date | null,
) {
  return client.dipCheckpoint.upsert({
    where: { endpoint_electoralTerm: { endpoint, electoralTerm } },
    create: { endpoint, electoralTerm, updatedThrough },
    update: { updatedThrough },
  });
}
