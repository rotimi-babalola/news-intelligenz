import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { MAX_ATTEMPTS_DEFAULT } from "./policy";
import type { SourceRef } from "./refs";

export function dedupeKey(
  runId: string,
  itemIndex: number | null,
  operation: string,
) {
  return `${runId}:${itemIndex ?? "-"}:${operation}`;
}

// Operator retries are deliberate duplicates of existing work: the base
// identity stays visible while a fresh attempt gets its own row.
export function manualDedupeKey(
  runId: string,
  itemIndex: number | null,
  operation: string,
) {
  return `${dedupeKey(runId, itemIndex, operation)}:manual:${randomUUID()}`;
}

export type EnqueueSpec = {
  source: SourceRef;
  runId: string;
  itemIndex?: number | null;
  dedupeKey?: string;
  operation: string;
  payload: Prisma.InputJsonValue;
  maxAttempts?: number;
  priority?: number;
};

// The one mapping from an identity to a job row, shared by single upserts and
// bulk createMany so both write the same key, source and payload.
export function jobRow(spec: EnqueueSpec) {
  return {
    id: randomUUID(),
    dedupeKey:
      spec.dedupeKey ??
      dedupeKey(spec.runId, spec.itemIndex ?? null, spec.operation),
    sourceKind: spec.source.kind,
    sourceKey: spec.source.key,
    sourceScope: (spec.source.scope ?? undefined) as
      Prisma.InputJsonValue | undefined,
    runId: spec.runId,
    itemIndex: spec.itemIndex ?? null,
    operation: spec.operation,
    payload: spec.payload,
    maxAttempts: spec.maxAttempts ?? MAX_ATTEMPTS_DEFAULT,
    priority: spec.priority ?? 0,
  };
}

export async function enqueueJob(
  tx: PrismaClient | Prisma.TransactionClient,
  spec: EnqueueSpec,
) {
  const row = jobRow(spec);
  return tx.processingJob.upsert({
    where: { dedupeKey: row.dedupeKey },
    create: row,
    update: {},
  });
}
