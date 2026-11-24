import Link from "next/link";
import { notFound } from "next/navigation";
import { dateText } from "../../_components/display";
import { database } from "../../../../src/db";
import {
  getSourceDocumentPage,
  isSafePdfUrl,
  pdfPageUrl,
  sourceDocumentUrl,
} from "../../../../src/dip/documents/source";
import {
  sourceProceedingUrl,
  sourceStepUrl,
} from "../../../../src/dip/proceedings/source";

export const dynamic = "force-dynamic";

function pageNumber(raw: string | string[] | undefined) {
  if (raw === undefined) return 1;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const page = Number(raw);
  return page >= 1 ? page : null;
}

export default async function SourceDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ referenceId: string }>;
  searchParams: Promise<{
    page?: string | string[];
    step?: string | string[];
  }>;
}) {
  const { referenceId } = await params;
  const query = await searchParams;
  const page = pageNumber(query.page);
  const stepId = query.step;
  if (
    !/^\d+$/.test(referenceId) ||
    page === null ||
    (stepId !== undefined &&
      (typeof stepId !== "string" || !/^\d+$/.test(stepId)))
  )
    notFound();
  const prisma = database();
  try {
    const view = await getSourceDocumentPage(prisma, referenceId, page, stepId);
    if (view.status === "unknown") notFound();
    const { source } = view;
    const pdfHref = isSafePdfUrl(source.pdfUrl)
      ? pdfPageUrl(source.pdfUrl, page)
      : null;
    return (
      <div className="min-h-screen bg-stone-100 text-stone-900 antialiased">
        <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
          <nav
            aria-label="Source navigation"
            className="flex flex-wrap gap-4 text-sm"
          >
            <Link
              href={sourceStepUrl(source.stepApiId)}
              className="font-medium text-emerald-900 underline-offset-4 hover:underline"
            >
              ← Back to the proceeding step
            </Link>
            <Link
              href={sourceProceedingUrl(source.proceedingApiId)}
              className="font-medium text-emerald-900 underline-offset-4 hover:underline"
            >
              Proceeding timeline
            </Link>
          </nav>

          <header>
            <p className="text-xs font-semibold tracking-[0.14em] text-emerald-900">
              NEWS INTELLIGENZ / SOURCE
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              Document {source.documentNumber}
            </h1>
            <p className="mt-2 text-sm text-stone-600">
              Page {page}
              {dateText(source.documentDate)
                ? ` · ${dateText(source.documentDate)}`
                : ""}
            </p>
            <p className="mt-2 text-sm">
              {pdfHref ? (
                <a
                  href={pdfHref}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-emerald-900 underline underline-offset-2"
                >
                  Open PDF at page {page}
                </a>
              ) : (
                <span className="text-stone-500">
                  No original PDF link is stored for this document.
                </span>
              )}
            </p>
          </header>

          {(view.status === "metadata-only" ||
            view.status === "not-processed") && (
            <section
              aria-labelledby="unavailable-heading"
              className="rounded-xl border border-amber-200 bg-amber-50 p-5"
            >
              <h2
                id="unavailable-heading"
                className="text-lg font-semibold text-amber-900"
              >
                {view.status === "not-processed"
                  ? "PDF not processed"
                  : "Document text not available"}
              </h2>
              <p className="mt-2 text-sm text-amber-900">{view.reason}</p>
              <p className="mt-2 text-sm text-amber-900">
                {pdfHref
                  ? "The stored page text is not available for this document. The original PDF is linked above."
                  : "The stored page text and an original PDF link are not available for this document."}
              </p>
            </section>
          )}

          {view.status === "page-missing" && (
            <section
              aria-labelledby="page-missing-heading"
              className="rounded-xl border border-amber-200 bg-amber-50 p-5"
            >
              <h2
                id="page-missing-heading"
                className="text-lg font-semibold text-amber-900"
              >
                Page {page} is not stored
              </h2>
              <p className="mt-2 text-sm text-amber-900">
                This document has {view.pageCount}{" "}
                {view.pageCount === 1 ? "stored page" : "stored pages"}. Only
                stored page text can be shown; the original PDF is linked above.
              </p>
            </section>
          )}

          {view.status === "available" && (
            <article className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
              {view.section && (
                <p className="text-xs font-medium text-stone-500">
                  {view.section.label} · {view.section.title}
                  {" · pages "}
                  {view.section.startPage}–{view.section.endPage}
                </p>
              )}
              <h2 className="mt-2 text-lg font-semibold">Stored page text</h2>
              <p className="mt-3 text-sm leading-relaxed whitespace-pre-line">
                {view.text}
              </p>
            </article>
          )}

          {view.status === "available" && view.pageCount > 1 && (
            <nav
              aria-label="Document pages"
              className="flex items-center justify-between gap-4 text-sm"
            >
              {page > 1 ? (
                <Link
                  href={sourceDocumentUrl(referenceId, {
                    page: page - 1,
                    stepId: source.stepApiId,
                  })}
                  className="font-medium text-emerald-900 underline underline-offset-2"
                >
                  ← Previous page
                </Link>
              ) : (
                <span />
              )}
              <span className="text-stone-600">
                Page {page} of {view.pageCount}
              </span>
              {page < view.pageCount ? (
                <Link
                  href={sourceDocumentUrl(referenceId, {
                    page: page + 1,
                    stepId: source.stepApiId,
                  })}
                  className="font-medium text-emerald-900 underline underline-offset-2"
                >
                  Next page →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </main>
      </div>
    );
  } finally {
    await prisma.$disconnect();
  }
}
