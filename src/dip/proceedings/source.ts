import type { PrismaClient } from "../../generated/prisma/client";
import { findProceedingForTimeline, findStepForTimeline } from "../db/index";
import { toTimelineProceeding, toTimelineStep } from "./timeline";

export function sourceStepUrl(apiId: string) {
  return `/source/step/${apiId}`;
}

export function sourceProceedingUrl(apiId: string) {
  return `/source/proceeding/${apiId}`;
}

// The reader-facing step view: the stored step and the proceeding it belongs
// to, shaped by the same timeline read model used by dossiers and explainers.
export async function getSourceStep(prisma: PrismaClient, apiId: string) {
  if (!/^\d+$/.test(apiId)) return null;
  const step = await findStepForTimeline(prisma, apiId);
  if (!step) return null;
  const proceeding = await findProceedingForTimeline(
    prisma,
    step.proceedingApiId,
  );
  return {
    step: toTimelineStep(step),
    proceedingApiId: step.proceedingApiId,
    proceeding: proceeding ? toTimelineProceeding(proceeding) : null,
    parentMissing: !proceeding,
  };
}
