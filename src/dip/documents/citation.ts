import type { PrismaClient } from "../../generated/prisma/client";
import {
  findDocumentReferenceById,
  findDocumentReferenceForStep,
  latestDocumentContent,
} from "../db/index";
import { classifyDocumentReference } from "./excerpts";

type ReferenceRow = NonNullable<
  Awaited<ReturnType<typeof findDocumentReferenceById>>
>;
type ContentRow = NonNullable<
  Awaited<ReturnType<typeof latestDocumentContent>>
>;

export type DocumentReference = ReferenceRow;

export type DocumentVariant = Pick<
  ContentRow,
  | "id"
  | "variantNo"
  | "byteHash"
  | "pageCount"
  | "objectKey"
  | "bytes"
  | "sourceUrl"
  | "requestedUrl"
  | "fetchedAt"
>;

type DocumentEligibility = ReturnType<typeof classifyDocumentReference>;
type MetadataOnly = Extract<DocumentEligibility, { status: "metadata-only" }>;
type Eligible = Extract<DocumentEligibility, { status: "excerpt-eligible" }>;

// The reference's pdf_url changed after the latest variant was processed, so
// surfaces withhold its text even though the document itself is eligible.
export const STALE_REVISION_REASON = "Document revision has not been processed";

// The one currency rule outside SQL: stored text may be cited only while the
// latest stored variant was fetched for the reference's current PDF URL.
// `searchDipEmbeddings` reproduces this predicate in its join as a batch
// projection (`c.is_latest` plus `c.requested_url` = `r.pdf_url`).
export function isCurrentDocumentVariant(
  requestedUrl: string | null,
  pdfUrl: string | null,
) {
  return pdfUrl !== null && requestedUrl === pdfUrl;
}

// A search hit cites the variant it was indexed from; it stays citable only
// while that exact variant is still the current one.
export function isCitedDocumentVariant(
  variant: DocumentVariant,
  cited: { variantNo: number; pdfUrl: string | null },
) {
  return (
    variant.variantNo === cited.variantNo &&
    isCurrentDocumentVariant(variant.requestedUrl, cited.pdfUrl)
  );
}

function documentEligibility(reference: DocumentReference) {
  return classifyDocumentReference({
    institution: reference.step.institution,
    documentType: reference.step.documentType,
    documentNumber: reference.documentNumber,
    pdfUrl: reference.pdfUrl,
    metadata: reference.metadata,
  });
}

// One answer to "what may be shown from this reference": no row, ineligible
// metadata, no stored variant, a variant the reference has moved away from, or
// the current variant. Each status carries the latest stored variant when one
// exists; surfaces map the status to their published values and pick the fields
// they show.
export type DocumentCitation =
  | { status: "unknown" }
  | {
      status: "metadata-only";
      reference: DocumentReference;
      eligibility: MetadataOnly;
      variant: DocumentVariant | null;
    }
  | {
      status: "missing";
      reference: DocumentReference;
      eligibility: Eligible;
      variant: null;
    }
  | {
      status: "stale";
      reference: DocumentReference;
      eligibility: Eligible;
      variant: DocumentVariant;
    }
  | {
      status: "current";
      reference: DocumentReference;
      eligibility: Eligible;
      variant: DocumentVariant;
    };

type ResolvedDocumentCitation = Exclude<
  DocumentCitation,
  { status: "unknown" }
>;

export function resolveDocumentCitation(
  reference: DocumentReference,
  variant: DocumentVariant | null,
  eligibility = documentEligibility(reference),
): ResolvedDocumentCitation {
  if (eligibility.status === "metadata-only")
    return { status: "metadata-only", reference, eligibility, variant };
  if (!variant) return { status: "missing", reference, eligibility, variant };
  if (!isCurrentDocumentVariant(variant.requestedUrl, reference.pdfUrl))
    return { status: "stale", reference, eligibility, variant };
  return { status: "current", reference, eligibility, variant };
}

export async function loadDocumentCitation(
  prisma: PrismaClient,
  referenceId: string,
  stepApiId?: string,
): Promise<DocumentCitation> {
  const reference =
    stepApiId !== undefined
      ? await findDocumentReferenceForStep(prisma, stepApiId)
      : await findDocumentReferenceById(prisma, referenceId);
  if (
    !reference ||
    (stepApiId !== undefined && reference.referenceId !== referenceId)
  )
    return { status: "unknown" };
  const eligibility = documentEligibility(reference);
  // Ineligible metadata never needs the stored variant, so it is never read.
  const variant =
    eligibility.status === "excerpt-eligible"
      ? await latestDocumentContent(prisma, reference.referenceId)
      : null;
  return resolveDocumentCitation(reference, variant, eligibility);
}
