type ReferenceEvidence = {
  institution: string | null;
  documentType: string | null;
  documentNumber: string | null;
  pdfUrl: string | null;
  metadata: unknown;
};

export function classifyDocumentReference(reference: ReferenceEvidence) {
  const metadata =
    reference.metadata &&
    typeof reference.metadata === "object" &&
    !Array.isArray(reference.metadata)
      ? (reference.metadata as Record<string, unknown>)
      : {};
  const issuer = metadata["herausgeber"];
  const type = metadata["dokumentart"];
  if (issuer !== "BT" && issuer !== "BR")
    return {
      status: "metadata-only" as const,
      reason: "Unconfirmed official issuer",
    };
  if (reference.institution !== issuer)
    return {
      status: "metadata-only" as const,
      reason: "Issuer and step institution differ",
    };
  if (
    (type !== "Drucksache" && type !== "Plenarprotokoll") ||
    reference.documentType !== type
  )
    return {
      status: "metadata-only" as const,
      reason: "Unconfirmed document type",
    };
  if (!reference.documentNumber?.trim())
    return {
      status: "metadata-only" as const,
      reason: "Missing document number",
    };
  try {
    if (!reference.pdfUrl || new URL(reference.pdfUrl).protocol !== "https:")
      throw new Error("Invalid source link");
  } catch {
    return {
      status: "metadata-only" as const,
      reason: "Missing original HTTPS link",
    };
  }
  const prefix = issuer === "BT" ? "BT" : "BR";
  return {
    status: "excerpt-eligible" as const,
    reason: "Confirmed official parliamentary document",
    source: "Deutscher Bundestag/Bundesrat – DIP",
    document: `${prefix}-${type === "Drucksache" ? "Drs." : "PlPr."} ${reference.documentNumber.trim()}`,
    originalUrl: reference.pdfUrl,
  };
}

export function readDocumentExcerpt(
  reference: ReferenceEvidence,
  page: number | null,
  text: string | null,
) {
  const classification = classifyDocumentReference(reference);
  if (classification.status === "metadata-only") return classification;
  if (!Number.isInteger(page) || page === null || page < 1 || !text)
    return {
      status: "metadata-only" as const,
      reason: "No page-scoped excerpt",
    };
  return {
    ...classification,
    page,
    text,
    changes: "Text extracted from PDF and excerpted",
  };
}
