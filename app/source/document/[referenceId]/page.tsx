import Link from "next/link";
import { notFound } from "next/navigation";
import { database } from "../../../../src/db";
import {
  getSourceDocumentPage,
  pdfPageUrl,
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

function dateText(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "long",
        timeZone: "UTC",
      }).format(new Date(value))
    : null;
}

export default async function SourceDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ referenceId: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { referenceId } = await params;
  const page = pageNumber((await searchParams).page);
  if (!/^\d+$/.test(referenceId) || page === null) notFound();
  const prisma = database();
  try {
    const view = await getSourceDocumentPage(prisma, referenceId, page);
    if (view.status === "unknown") notFound();
    const { source } = view;
    const pdfHref = source.pdfUrl ? pdfPageUrl(source.pdfUrl, page) : null;
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

          {view.status === "not-processed" && (
            <section
              aria-labelledby="not-processed-heading"
              className="rounded-xl border border-amber-200 bg-amber-50 p-5"
            >
              <h2
                id="not-processed-heading"
                className="text-lg font-semibold text-amber-900"
              >
                PDF not processed
              </h2>
              <p className="mt-2 text-sm text-amber-900">{view.reason}</p>
              <p className="mt-2 text-sm text-amber-900">
                The stored page text is not available for this document. The
                original PDF is linked above.
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
        </main>
      </div>
    );
  } finally {
    await prisma.$disconnect();
  }
}
