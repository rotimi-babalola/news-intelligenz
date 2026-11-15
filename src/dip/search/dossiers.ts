import type { PrismaClient } from "../../generated/prisma/client";
import {
  DOSSIER_CURRENT_ACTIVITY_DAYS,
  DOSSIER_CURRENT_ACTIVITY_WEIGHT,
  DOSSIER_DOCUMENT_LIMIT,
  DOSSIER_RECENCY_WEIGHT,
  DOSSIER_STEP_COUNT_CAP,
  DOSSIER_STEP_WEIGHT,
} from "../constants";
import { embedText } from "./embedding";
import {
  getProceedings,
  type ProceedingTimeline,
} from "../proceedings/timeline";
import { searchDip, type DipHit } from "./search";

type TimelineStep = ProceedingTimeline["steps"][number];
type DocumentHit = Extract<DipHit, { entity: "dokument" }>;

// Evidence dominates the score; these signals are tie-breakers that add at most
// 0.10 combined, so they only reorder proceedings with near-equal evidence.

// A document hit is only current when its step still links the same reference
// and PDF; otherwise the citation would point at replaced bytes.
function sameDocument(step: TimelineStep, hit: DocumentHit) {
  return (
    step.apiId === hit.source.apiId &&
    step.document?.referenceId === hit.document.referenceId &&
    step.document?.pdfUrl === hit.document.pdfUrl
  );
}

function isCurrent(hit: DipHit, timeline: ProceedingTimeline) {
  if (hit.entity === "vorgang")
    return timeline.proceeding?.versionNo === hit.versionNo;
  if (hit.entity === "vorgangsposition")
    return timeline.steps.some(
      (step) => step.apiId === hit.apiId && step.versionNo === hit.versionNo,
    );
  return timeline.steps.some((step) => sameDocument(step, hit));
}

export function buildDossiers(
  hits: DipHit[],
  timelines: Map<string, ProceedingTimeline>,
  limit: number,
  now = new Date(),
) {
  const grouped = new Map<
    string,
    { timeline: ProceedingTimeline; evidence: DipHit[] }
  >();
  for (const hit of hits) {
    const apiId = hit.entity === "vorgang" ? hit.apiId : hit.proceedingApiId;
    if (!apiId) continue;
    const timeline = timelines.get(apiId);
    if (!timeline || !isCurrent(hit, timeline)) continue;
    const group = grouped.get(apiId);
    if (group) group.evidence.push(hit);
    else grouped.set(apiId, { timeline, evidence: [hit] });
  }

  return [...grouped]
    .map(([apiId, { timeline, evidence }]) => {
      evidence.sort(
        (a, b) => b.score - a.score || a.apiId.localeCompare(b.apiId),
      );
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
        stepCount:
          Math.min(timeline.steps.length, DOSSIER_STEP_COUNT_CAP) *
          DOSSIER_STEP_WEIGHT,
        recency:
          ageDays >= 0 && Number.isFinite(ageDays)
            ? DOSSIER_RECENCY_WEIGHT /
              (1 + ageDays / DOSSIER_CURRENT_ACTIVITY_DAYS)
            : 0,
        currentActivity:
          ageDays >= 0 && ageDays <= DOSSIER_CURRENT_ACTIVITY_DAYS
            ? DOSSIER_CURRENT_ACTIVITY_WEIGHT
            : 0,
      };
      return {
        apiId,
        parentMissing: timeline.parentMissing,
        title: timeline.proceeding?.title ?? null,
        proceedingVersionNo: timeline.proceeding?.versionNo ?? null,
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

export function addDocumentEvidence(
  dossiers: ReturnType<typeof buildDossiers>,
  hits: DipHit[],
) {
  return dossiers.map((dossier) => {
    if (
      dossier.evidence.some(
        (hit) =>
          hit.entity === "dokument" &&
          hit.excerpt.status === "excerpt-eligible",
      )
    )
      return dossier;
    const documents: DocumentHit[] = [];
    for (const hit of hits) {
      if (
        hit.entity !== "dokument" ||
        hit.proceedingApiId !== dossier.apiId ||
        hit.excerpt.status !== "excerpt-eligible" ||
        !dossier.steps.some((step) => sameDocument(step, hit)) ||
        documents.some(
          (document) =>
            document.document.referenceId === hit.document.referenceId,
        )
      )
        continue;
      documents.push(hit);
      if (documents.length === DOSSIER_DOCUMENT_LIMIT) break;
    }
    return documents.length
      ? { ...dossier, evidence: [...dossier.evidence, ...documents] }
      : dossier;
  });
}

export async function searchProceedingDossiers(
  prisma: PrismaClient,
  query: string,
  limit: number,
) {
  const embedding = await embedText(query, "query");
  // Read-only: no transaction, so a slow vector scan never hits an interactive
  // transaction timeout. `isCurrent` already drops hits that changed meanwhile.
  const hits = await searchDip(prisma, query, Math.max(100, limit * 5), {
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
  const dossiers = buildDossiers(
    hits,
    await getProceedings(prisma, ids),
    limit,
  );
  const missing = dossiers
    .filter(
      (dossier) =>
        !dossier.evidence.some(
          (hit) =>
            hit.entity === "dokument" &&
            hit.excerpt.status === "excerpt-eligible",
        ),
    )
    .map((dossier) => dossier.apiId);
  if (!missing.length) return dossiers;
  // Step hits can fill the global window before a relevant PDF page appears.
  const documents = await searchDip(prisma, query, missing.length * 5, {
    embed: async () => embedding,
    documentProceedingIds: missing,
  });
  return addDocumentEvidence(dossiers, documents);
}
