import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/prisma/client";
import { MAX_ATTEMPTS_DEFAULT } from "./policy";
import type { SourceRef } from "./refs";

export function dedupeKey(
  runId: string,
  itemIndex: number | null,
  operation: string,
) {
  return `${runId}:${itemIndex ?? "-"}:${operation}`;
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

export async function enqueueJob(
  tx: Prisma.TransactionClient,
  spec: EnqueueSpec,
) {
  const key =
    spec.dedupeKey ??
    dedupeKey(spec.runId, spec.itemIndex ?? null, spec.operation);
  return tx.processingJob.upsert({
    where: { dedupeKey: key },
    create: {
      id: randomUUID(),
      dedupeKey: key,
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
    },
    update: {},
  });
}
