import type { PrismaClient } from "../generated/prisma/client";
import { embedText } from "./embedding";
import { getProceeding } from "./proceeding";
import { searchDip } from "./search";

type Hit = Awaited<ReturnType<typeof searchDip>>[number];
type Timeline = NonNullable<Awaited<ReturnType<typeof getProceeding>>>;

export function buildDossiers(
  hits: Hit[],
  timelines: Map<string, Timeline | null>,
  limit: number,
  now = new Date(),
) {
  const grouped = new Map<string, Hit[]>();
  for (const hit of hits) {
    const apiId = hit.entity === "vorgang" ? hit.apiId : hit.proceedingApiId;
    if (!apiId) continue;
    const timeline = timelines.get(apiId);
    if (!timeline) continue;
    const current =
      hit.entity === "vorgang"
        ? timeline.proceeding?.versionNo === hit.versionNo
        : hit.entity === "vorgangsposition"
          ? timeline.steps.some(
              (step) =>
                step.apiId === hit.apiId && step.versionNo === hit.versionNo,
            )
          : timeline.steps.some(
              (step) =>
                step.apiId === hit.source.apiId &&
                step.document?.referenceId === hit.document?.referenceId &&
                step.document?.pdfUrl === hit.document?.pdfUrl,
            );
    if (current) grouped.set(apiId, [...(grouped.get(apiId) ?? []), hit]);
  }

  return [...grouped]
    .map(([apiId, matches]) => {
      const timeline = timelines.get(apiId)!;
      const seenPages = new Set<string>();
      const documentCounts = new Map<string, number>();
      const evidence = matches
        .sort((a, b) => b.score - a.score || a.apiId.localeCompare(b.apiId))
        .filter((hit) => {
          if (hit.entity !== "dokument") return true;
          const documentId = hit.document?.referenceId;
          if (!documentId) return false;
          const page = `${documentId}:${hit.page}`;
          if (seenPages.has(page) || (documentCounts.get(documentId) ?? 0) >= 2)
            return false;
          seenPages.add(page);
          documentCounts.set(
            documentId,
            (documentCounts.get(documentId) ?? 0) + 1,
          );
          return true;
        });
      const dates = timeline.steps
        .map((step) => step.documentDate)
        .filter((date): date is string => date !== null);
      if (timeline.proceeding?.documentDate)
        dates.push(timeline.proceeding.documentDate);
      dates.sort();
      const firstActivity = dates[0] ?? null;
      const lastActivity = dates.at(-1) ?? null;
      const ageDays = lastActivity
        ? (now.getTime() - new Date(lastActivity).getTime()) / 86_400_000
        : Infinity;
      const ranking = {
        strongestEvidence: Math.max(...evidence.map((hit) => hit.score)),
        stepCount: Math.min(timeline.steps.length, 10) * 0.005,
        recency:
          ageDays >= 0 && Number.isFinite(ageDays)
            ? 0.03 / (1 + ageDays / 30)
            : 0,
        currentActivity: ageDays >= 0 && ageDays <= 30 ? 0.02 : 0,
      };
      return {
        apiId,
        parentMissing: timeline.parentMissing,
        title: timeline.proceeding?.title ?? null,
        type: timeline.proceeding?.type ?? null,
        deliberationState: timeline.proceeding?.deliberationState ?? null,
        firstActivity,
        lastActivity,
        sourceUrl: timeline.proceeding?.sourceUrl ?? null,
        steps: timeline.steps,
        evidence,
        ranking,
        score: Object.values(ranking).reduce((sum, value) => sum + value, 0),
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.apiId.localeCompare(b.apiId, "en", { numeric: true }),
    )
    .slice(0, limit);
}

export async function searchProceedingDossiers(
  prisma: PrismaClient,
  query: string,
  limit: number,
) {
  const embedding = await embedText(query, "query");
  return prisma.$transaction(
    async (tx) => {
      const hits = await searchDip(tx, query, Math.max(100, limit * 5), {
        embed: async () => embedding,
      });
      const ids = [
        ...new Set(
          hits
            .map((hit) =>
              hit.entity === "vorgang" ? hit.apiId : hit.proceedingApiId,
            )
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const timelines = new Map(
        await Promise.all(
          ids.map(async (id) => [id, await getProceeding(tx, id)] as const),
        ),
      );
      return buildDossiers(hits, timelines, limit);
    },
    { isolationLevel: "RepeatableRead", timeout: 30_000 },
  );
}
