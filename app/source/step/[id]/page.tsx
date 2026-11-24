import Link from "next/link";
import { notFound } from "next/navigation";
import { dateText } from "../../_components/display";
import { database } from "../../../../src/db";
import {
  getSourceDocumentOutline,
  sourceDocumentUrl,
} from "../../../../src/dip/documents/source";
import {
  getSourceStep,
  sourceProceedingUrl,
} from "../../../../src/dip/proceedings/source";

export const dynamic = "force-dynamic";

const institutionNames: Record<string, string> = {
  BT: "Bundestag",
  BR: "Bundesrat",
  BV: "Bundesversammlung",
  EK: "Europakammer",
};

export default async function SourceStepPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const prisma = database();
  try {
    const view = await getSourceStep(prisma, id);
    if (!view) notFound();
    const { step, proceedingApiId, proceeding, parentMissing } = view;
    const document = step.document;
    const sections = document
      ? await getSourceDocumentOutline(prisma, document.referenceId)
      : [];
    const date = dateText(step.documentDate);
    return (
      <div className="min-h-screen bg-stone-100 text-stone-900 antialiased">
        <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
          <nav aria-label="Source navigation" className="text-sm">
            <Link
              href={sourceProceedingUrl(proceedingApiId)}
              className="font-medium text-emerald-900 underline-offset-4 hover:underline"
            >
              ← Back to the proceeding timeline
            </Link>
          </nav>

          <header>
            <p className="text-xs font-semibold tracking-[0.14em] text-emerald-900">
              NEWS INTELLIGENZ / SOURCE
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              {step.title}
            </h1>
            <p className="mt-2 text-sm text-stone-600">
              {institutionNames[step.institution] ?? step.institution} ·{" "}
              {step.label}
              {date ? ` · ${date}` : ""}
            </p>
            {proceeding && (
              <p className="mt-1 text-sm text-stone-500">
                Proceeding: {proceeding.title}
              </p>
            )}
          </header>

          {parentMissing && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              The parent proceeding record is not stored. Only this step and its
              document reference are available.
            </p>
          )}

          <section
            aria-labelledby="step-text-heading"
            className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
          >
            <h2 id="step-text-heading" className="text-lg font-semibold">
              Step text
            </h2>
            {step.text ? (
              <p className="mt-3 text-sm leading-relaxed whitespace-pre-line">
                {step.text}
              </p>
            ) : (
              <p className="mt-3 text-sm text-stone-500">
                No step text is stored for this step.
              </p>
            )}
          </section>

          <section
            aria-labelledby="documents-heading"
            className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
          >
            <h2 id="documents-heading" className="text-lg font-semibold">
              Document reference
            </h2>
            {document ? (
              <div className="mt-3 space-y-2 text-sm">
                <p className="font-medium">{document.number}</p>
                {dateText(document.date) && (
                  <p className="text-stone-500">
                    Document date: {dateText(document.date)}
                  </p>
                )}
                <p className="flex flex-wrap gap-4">
                  <Link
                    href={sourceDocumentUrl(document.referenceId)}
                    className="font-medium text-emerald-900 underline underline-offset-2"
                  >
                    View stored document pages
                  </Link>
                  {document.pdfUrl && (
                    <a
                      href={document.pdfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-emerald-900 underline underline-offset-2"
                    >
                      Open PDF
                    </a>
                  )}
                </p>
                {sections.length > 0 && (
                  <div className="pt-2">
                    <h3 className="text-sm font-semibold">Document pages</h3>
                    <ul className="mt-1 space-y-1">
                      {sections.map((section) => (
                        <li
                          key={`${section.startPage}-${section.endPage}-${section.label}`}
                        >
                          <Link
                            href={sourceDocumentUrl(
                              document.referenceId,
                              section.startPage,
                            )}
                            className="text-emerald-900 underline underline-offset-2"
                          >
                            {section.label} · {section.title}
                          </Link>{" "}
                          <span className="text-stone-500">
                            (pages {section.startPage}–{section.endPage})
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-3 text-sm text-stone-500">
                No document reference is stored for this step.
              </p>
            )}
          </section>
        </main>
      </div>
    );
  } finally {
    await prisma.$disconnect();
  }
}
