import type {
  Proceeding,
  ProceedingStep,
  PrismaClient,
} from "../generated/prisma/client";

// DIP import-run inspection queries. Parliamentary records live apart from
// news publications: candidates carry only { endpoint, id }, so titles are
// resolved from the stored proceeding/step rows instead of news metadata.
export async function listDipRuns(prisma: PrismaClient) {
  return prisma.run.findMany({
    where: { sourceKind: "dip_endpoint" },
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    take: 100,
  });
}

export type DipCandidateView = {
  runId: string;
  itemIndex: number;
  errors: unknown[];
  metadata: unknown;
  endpoint: string;
  apiId: string | null;
  kind: "vorgang" | "vorgangsposition" | "unknown";
  title: string;
  subtitle: string;
};

function dipMeta(metadata: unknown): {
  endpoint: string;
  apiId: string | null;
} {
  if (typeof metadata !== "object" || metadata === null)
    return { endpoint: "", apiId: null };
  const m = metadata as Record<string, unknown>;
  return {
    endpoint: typeof m["endpoint"] === "string" ? m["endpoint"] : "",
    apiId: typeof m["id"] === "string" ? m["id"] : null,
  };
}

export type DipProceedingSummary = Pick<
  Proceeding,
  "apiId" | "title" | "proceedingType" | "electoralTerm"
>;
export type DipStepSummary = Pick<
  ProceedingStep,
  | "apiId"
  | "title"
  | "institution"
  | "stepLabel"
  | "documentType"
  | "proceedingApiId"
>;

// Pure title resolution for one DIP candidate: stored proceedings and steps
// supply the headline, so the admin never renders "Unknown" for DIP rows.
// Unstored or malformed candidates fall back to their endpoint and API ID.
export function toDipCandidateView(
  row: {
    runId: string;
    itemIndex: number;
    errors: unknown;
    metadata: unknown;
  },
  proceedings: Map<string, DipProceedingSummary>,
  steps: Map<string, DipStepSummary>,
): DipCandidateView {
  const m = dipMeta(row.metadata);
  const errors = row.errors as unknown[];
  if (m.endpoint === "/vorgang" && m.apiId) {
    const p = proceedings.get(m.apiId);
    return {
      runId: row.runId,
      itemIndex: row.itemIndex,
      errors,
      metadata: row.metadata,
      endpoint: m.endpoint,
      apiId: m.apiId,
      kind: "vorgang" as const,
      title: p?.title ?? `Vorgang ${m.apiId}`,
      subtitle: p
        ? `${p.proceedingType} · WP ${p.electoralTerm}`
        : "Not stored (invalid or capped)",
    };
  }
  if (m.endpoint === "/vorgangsposition" && m.apiId) {
    const s = steps.get(m.apiId);
    return {
      runId: row.runId,
      itemIndex: row.itemIndex,
      errors,
      metadata: row.metadata,
      endpoint: m.endpoint,
      apiId: m.apiId,
      kind: "vorgangsposition" as const,
      title: s?.title ?? `Vorgangsposition ${m.apiId}`,
      subtitle: s
        ? `${s.institution} · ${s.stepLabel} · ${s.documentType} · Vorgang ${s.proceedingApiId}`
        : "Not stored (invalid or unresolved parent)",
    };
  }
  return {
    runId: row.runId,
    itemIndex: row.itemIndex,
    errors,
    metadata: row.metadata,
    endpoint: m.endpoint,
    apiId: m.apiId,
    kind: "unknown" as const,
    title: m.apiId ?? "Unidentified candidate",
    subtitle: m.endpoint || "No endpoint metadata",
  };
}

export async function listDipCandidates(
  prisma: PrismaClient,
  runId: string,
): Promise<DipCandidateView[]> {
  if (!runId) return [];
  const rows = await prisma.candidate.findMany({
    where: { runId },
    orderBy: { itemIndex: "asc" },
    take: 100,
  });
  const vorgangIds = new Set<string>();
  const stepIds = new Set<string>();
  const metas = rows.map((c) => dipMeta(c.metadata));
  for (const m of metas) {
    if (!m.apiId) continue;
    if (m.endpoint === "/vorgang") vorgangIds.add(m.apiId);
    else if (m.endpoint === "/vorgangsposition") stepIds.add(m.apiId);
  }
  const [proceedings, steps] = await Promise.all([
    vorgangIds.size
      ? prisma.proceeding.findMany({
          where: { apiId: { in: [...vorgangIds] } },
        })
      : [],
    stepIds.size
      ? prisma.proceedingStep.findMany({
          where: { apiId: { in: [...stepIds] } },
        })
      : [],
  ]);
  const proceedingById = new Map(proceedings.map((p) => [p.apiId, p]));
  const stepById = new Map(steps.map((s) => [s.apiId, s]));
  return rows.map((c) => toDipCandidateView(c, proceedingById, stepById));
}

export async function listParliamentaryDiscoveries(
  prisma: PrismaClient,
  runId: string,
) {
  if (!runId) return [];
  const rows = await prisma.parliamentaryDiscovery.findMany({
    where: { runId },
    orderBy: [{ entity: "asc" }, { apiId: "asc" }],
    take: 100,
  });
  const vorgangIds = rows
    .filter((d) => d.entity === "vorgang")
    .map((d) => d.apiId);
  const stepIds = rows
    .filter((d) => d.entity === "vorgangsposition")
    .map((d) => d.apiId);
  const [proceedings, steps] = await Promise.all([
    vorgangIds.length
      ? prisma.proceeding.findMany({ where: { apiId: { in: vorgangIds } } })
      : [],
    stepIds.length
      ? prisma.proceedingStep.findMany({ where: { apiId: { in: stepIds } } })
      : [],
  ]);
  const titleById = new Map<string, string>([
    ...proceedings.map((p) => [`vorgang:${p.apiId}`, p.title] as const),
    ...steps.map((s) => [`vorgangsposition:${s.apiId}`, s.title] as const),
  ]);
  return rows.map((d) => ({
    ...d,
    title: titleById.get(`${d.entity}:${d.apiId}`) ?? d.apiId,
  }));
}

export function listDipCheckpoints(prisma: PrismaClient) {
  return prisma.dipCheckpoint.findMany({
    orderBy: [{ endpoint: "asc" }, { electoralTerm: "asc" }],
  });
}
