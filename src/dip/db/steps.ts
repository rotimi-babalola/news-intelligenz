import type { Prisma } from "../../generated/prisma/client";
import type { Client } from "./client";

export function findStep(client: Client, apiId: string) {
  return client.proceedingStep.findUnique({ where: { apiId } });
}

export function latestStepVersion(client: Client, stepApiId: string) {
  return client.proceedingStepVersion.findFirst({
    where: { stepApiId },
    orderBy: { versionNo: "desc" },
  });
}

export function findStepVersion(
  client: Client,
  stepApiId: string,
  versionNo: number,
) {
  return client.proceedingStepVersion.findUnique({
    where: { stepApiId_versionNo: { stepApiId, versionNo } },
  });
}

export function createStep(
  client: Client,
  data: Prisma.ProceedingStepUncheckedCreateInput,
) {
  return client.proceedingStep.create({ data });
}

export function updateStep(
  client: Client,
  apiId: string,
  data: Prisma.ProceedingStepUncheckedUpdateInput,
) {
  return client.proceedingStep.update({ where: { apiId }, data });
}

export function createStepVersion(
  client: Client,
  data: Prisma.ProceedingStepVersionUncheckedCreateInput,
) {
  return client.proceedingStepVersion.create({ data });
}
