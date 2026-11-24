import type { PrismaClient } from "../../generated/prisma/client";
import {
  findDocumentChunk,
  findDocumentPage,
  latestDocumentContent,
} from "../db/index";
import { isCitedDocumentVariant } from "../documents/citation";
import { pdfPageUrl, sourceDocumentUrl } from "../documents/source";
import { sourceStepUrl } from "../proceedings/source";
import { getProceeding } from "../proceedings/timeline";
import type { BriefLanguage, Dossier, Evidence, TimelineStep } from "./types";

type CurrentProceeding = NonNullable<Awaited<ReturnType<typeof getProceeding>>>;

export function stepSource(step: TimelineStep) {
  return [
    step.documentDate,
    step.institution,
    step.label,
    step.title,
    step.text,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function stepDate(step: TimelineStep, language: BriefLanguage) {
  return step.documentDate
    ? new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(step.documentDate))
    : null;
}

export function pageEvidenceId(referenceId: string, page: number) {
  return `page:${referenceId}:${page}`;
}

export function matchesDossier(current: CurrentProceeding, dossier: Dossier) {
  return (
    (current.proceeding?.versionNo ?? null) === dossier.proceedingVersionNo &&
    current.steps.length === dossier.steps.length &&
    current.steps.every(
      (step, i) =>
        step.apiId === dossier.steps[i]?.apiId &&
        step.versionNo === dossier.steps[i]?.versionNo &&
        step.document?.referenceId ===
          dossier.steps[i]?.document?.referenceId &&
        step.document?.pdfUrl === dossier.steps[i]?.document?.pdfUrl,
    )
  );
}

// Only pages that are still the latest variant of the cited document become
// evidence; the returned identities are rechecked after generation.
export async function collectEvidence(
  prisma: PrismaClient,
  current: CurrentProceeding,
  dossier: Dossier,
) {
  const evidence: Evidence[] = current.steps.map((step) => ({
    id: `step:${step.apiId}`,
    text: stepSource(step),
    citation: {
      kind: "step",
      stepId: step.apiId,
      url: sourceStepUrl(step.apiId),
    },
  }));
  const documentVersions: [string, string, string][] = [];
  const citedPages = new Set<string>();
  for (const hit of dossier.evidence) {
    if (
      hit.entity !== "dokument" ||
      hit.excerpt.status !== "excerpt-eligible" ||
      !hit.page ||
      hit.chunk === null ||
      !hit.passage
    )
      continue;
    const step = current.steps.find(
      (item) =>
        item.apiId === hit.source.apiId &&
        item.document?.referenceId === hit.document.referenceId &&
        item.document.pdfUrl === hit.document.pdfUrl,
    );
    if (!step) continue;
    const variant = await latestDocumentContent(
      prisma,
      hit.document.referenceId,
    );
    if (
      !variant ||
      !isCitedDocumentVariant(variant, {
        variantNo: hit.versionNo,
        pdfUrl: hit.document.pdfUrl,
      })
    )
      continue;
    const storedChunk = await findDocumentChunk(
      prisma,
      variant.id,
      hit.page,
      hit.chunk,
    );
    if (storedChunk?.text !== hit.passage) continue;
    const id = pageEvidenceId(hit.document.referenceId, hit.page);
    if (citedPages.has(id)) continue;
    // The citation is the whole page, so the generator sees every chunk of it:
    // one retrieved passage must not hide the page's other relevant facts.
    const page = await findDocumentPage(prisma, variant.id, hit.page);
    documentVersions.push([
      hit.document.referenceId,
      variant.byteHash,
      hit.document.pdfUrl!,
    ]);
    citedPages.add(id);
    evidence.push({
      id,
      text: page?.text ?? hit.passage,
      citation: {
        kind: "page",
        stepId: step.apiId,
        referenceId: hit.document.referenceId,
        page: hit.page,
        url: sourceDocumentUrl(hit.document.referenceId, {
          page: hit.page,
          stepId: step.apiId,
        }),
        pdfUrl: pdfPageUrl(hit.document.pdfUrl!, hit.page),
      },
    });
  }
  return { evidence, documentVersions };
}
