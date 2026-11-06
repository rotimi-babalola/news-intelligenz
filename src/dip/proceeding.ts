import type { PrismaClient } from "../generated/prisma/client";
import { readProceedingTimeline } from "./repository";

function optionalText(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export async function getProceeding(prisma: PrismaClient, apiId: string) {
  if (!/^\d+$/.test(apiId))
    throw new Error("Proceeding API ID must be numeric");
  const { proceeding, steps } = await readProceedingTimeline(prisma, apiId);
  if (!proceeding && steps.length === 0) return null;

  return {
    apiId,
    parentMissing: !proceeding,
    proceeding: proceeding
      ? {
          title: proceeding.title,
          type: proceeding.proceedingType,
          deliberationState: proceeding.deliberationState,
          summary: optionalText(proceeding.metadata, "abstract"),
          documentDate: proceeding.documentDate?.toISOString() ?? null,
          sourceUpdatedAt: proceeding.sourceUpdatedAt.toISOString(),
          firstObservedAt: proceeding.firstObservedAt.toISOString(),
          lastObservedAt: proceeding.lastObservedAt.toISOString(),
          versionNo: proceeding.latestVersionNo,
          versionId: proceeding.versions[0]?.id ?? null,
          versionObservedAt:
            proceeding.versions[0]?.observedAt.toISOString() ?? null,
          sourceUrl: `https://search.dip.bundestag.de/api/v1/vorgang/${apiId}`,
        }
      : null,
    steps: steps
      .sort(
        (a, b) =>
          (a.documentDate?.getTime() ?? Infinity) -
            (b.documentDate?.getTime() ?? Infinity) ||
          a.sourceUpdatedAt.getTime() - b.sourceUpdatedAt.getTime() ||
          a.apiId.localeCompare(b.apiId, "en", { numeric: true }),
      )
      .map((step) => ({
        apiId: step.apiId,
        institution: step.institution,
        label: step.stepLabel,
        title: step.title,
        text: optionalText(step.metadata, "text"),
        documentType: step.documentType,
        documentDate: step.documentDate?.toISOString() ?? null,
        sourceUpdatedAt: step.sourceUpdatedAt.toISOString(),
        firstObservedAt: step.firstObservedAt.toISOString(),
        lastObservedAt: step.lastObservedAt.toISOString(),
        versionNo: step.latestVersionNo,
        versionId: step.versions[0]?.id ?? null,
        versionObservedAt: step.versions[0]?.observedAt.toISOString() ?? null,
        sourceUrl: `https://search.dip.bundestag.de/api/v1/vorgangsposition/${step.apiId}`,
        document: step.documentReference
          ? {
              referenceId: step.documentReference.referenceId,
              number: step.documentReference.documentNumber,
              date: step.documentReference.documentDate?.toISOString() ?? null,
              pdfUrl: step.documentReference.pdfUrl,
              metadata: step.documentReference.metadata,
              observedAt: step.documentReference.observedAt.toISOString(),
            }
          : null,
      })),
  };
}
