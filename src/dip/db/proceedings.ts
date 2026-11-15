import type { Prisma } from "../../generated/prisma/client";
import type { Client } from "./client";

export function findProceeding(client: Client, apiId: string) {
  return client.proceeding.findUnique({ where: { apiId } });
}

export function listRecentProceedings(client: Client) {
  return client.proceeding.findMany({
    orderBy: { lastObservedAt: "desc" },
    take: 6,
    select: { apiId: true, title: true },
  });
}

const proceedingInclude = {
  versions: { orderBy: { versionNo: "desc" }, take: 1 },
} satisfies Prisma.ProceedingInclude;

const stepInclude = {
  versions: { orderBy: { versionNo: "desc" }, take: 1 },
  documentReference: true,
} satisfies Prisma.ProceedingStepInclude;

type ProceedingTimelineRow = {
  proceeding: Prisma.ProceedingGetPayload<{
    include: typeof proceedingInclude;
  }> | null;
  steps: Prisma.ProceedingStepGetPayload<{ include: typeof stepInclude }>[];
};

export async function readProceedingTimeline(
  client: Client,
  apiId: string,
): Promise<ProceedingTimelineRow> {
  const [proceeding, steps] = await Promise.all([
    client.proceeding.findUnique({
      where: { apiId },
      include: proceedingInclude,
    }),
    client.proceedingStep.findMany({
      where: { proceedingApiId: apiId },
      include: stepInclude,
    }),
  ]);
  return { proceeding, steps };
}

// One query per table for a whole result page, so dossier assembly never
// becomes a per-proceeding round trip inside a transaction.
export async function readProceedingTimelines(
  client: Client,
  apiIds: string[],
): Promise<Map<string, ProceedingTimelineRow>> {
  const [proceedings, steps] = await Promise.all([
    client.proceeding.findMany({
      where: { apiId: { in: apiIds } },
      include: proceedingInclude,
    }),
    client.proceedingStep.findMany({
      where: { proceedingApiId: { in: apiIds } },
      include: stepInclude,
    }),
  ]);
  const rows = new Map<string, ProceedingTimelineRow>(
    apiIds.map((apiId) => [apiId, { proceeding: null, steps: [] }]),
  );
  for (const proceeding of proceedings) {
    const row = rows.get(proceeding.apiId);
    if (row) row.proceeding = proceeding;
  }
  for (const step of steps) rows.get(step.proceedingApiId)?.steps.push(step);
  return rows;
}

export function latestProceedingVersion(
  client: Client,
  proceedingApiId: string,
) {
  return client.proceedingVersion.findFirst({
    where: { proceedingApiId },
    orderBy: { versionNo: "desc" },
  });
}

export function findProceedingVersion(
  client: Client,
  proceedingApiId: string,
  versionNo: number,
) {
  return client.proceedingVersion.findUnique({
    where: { proceedingApiId_versionNo: { proceedingApiId, versionNo } },
  });
}

export function createProceeding(
  client: Client,
  data: Prisma.ProceedingUncheckedCreateInput,
) {
  return client.proceeding.create({ data });
}

export function updateProceeding(
  client: Client,
  apiId: string,
  data: Prisma.ProceedingUncheckedUpdateInput,
) {
  return client.proceeding.update({ where: { apiId }, data });
}

export function createProceedingVersion(
  client: Client,
  data: Prisma.ProceedingVersionUncheckedCreateInput,
) {
  return client.proceedingVersion.create({ data });
}

export function countProceedingsByTerm(client: Client, electoralTerm: number) {
  return client.proceeding.count({ where: { electoralTerm } });
}

// Capped step collection follows the stored proceeding set; a stable order
// keeps the request sequence reproducible across runs.
export function listProceedingApiIdsByTerm(
  client: Client,
  electoralTerm: number,
) {
  return client.proceeding.findMany({
    where: { electoralTerm },
    select: { apiId: true },
    orderBy: { apiId: "asc" },
  });
}
