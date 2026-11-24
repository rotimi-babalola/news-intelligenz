import type { PrismaClient } from "../../generated/prisma/client";
import { findStep } from "../db/index";
import { getProceeding } from "./timeline";

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
  const step = await findStep(prisma, apiId);
  if (!step) return null;
  const timeline = await getProceeding(prisma, step.proceedingApiId);
  const view = timeline?.steps.find((item) => item.apiId === apiId);
  if (!timeline || !view) return null;
  return {
    step: view,
    proceedingApiId: step.proceedingApiId,
    proceeding: timeline.proceeding,
    parentMissing: timeline.parentMissing,
  };
}
