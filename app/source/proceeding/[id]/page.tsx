import Link from "next/link";
import { notFound } from "next/navigation";
import { database } from "../../../../src/db";
import { sourceDocumentUrl } from "../../../../src/dip/documents/source";
import { sourceStepUrl } from "../../../../src/dip/proceedings/source";
import { getProceeding } from "../../../../src/dip/proceedings/timeline";

export const dynamic = "force-dynamic";

function dateText(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "long",
        timeZone: "UTC",
      }).format(new Date(value))
    : null;
}

export default async function SourceProceedingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const prisma = database();
  try {
    const timeline = await getProceeding(prisma, id);
    if (!timeline) notFound();
    return (
      <div className="min-h-screen bg-stone-100 text-stone-900 antialiased">
        <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
          <header>
            <p className="text-xs font-semibold tracking-[0.14em] text-emerald-900">
              NEWS INTELLIGENZ / SOURCE
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              {timeline.proceeding?.title ?? "Proceeding record missing"}
            </h1>
            {timeline.proceeding && (
              <p className="mt-2 text-sm text-stone-600">
                {timeline.proceeding.type}
                {timeline.proceeding.deliberationState
                  ? ` · ${timeline.proceeding.deliberationState}`
                  : ""}
              </p>
            )}
            {timeline.proceeding?.summary && (
              <p className="mt-3 text-sm leading-relaxed text-stone-700">
                {timeline.proceeding.summary}
              </p>
            )}
          </header>

          {timeline.parentMissing && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              The parent proceeding record is not stored. Only its documented
              steps are available.
            </p>
          )}

          <section aria-labelledby="timeline-heading" className="space-y-3">
            <h2 id="timeline-heading" className="text-lg font-semibold">
              Proceeding timeline
            </h2>
            {timeline.steps.length ? (
              <ol className="space-y-3">
                {timeline.steps.map((step) => {
                  const date = dateText(step.documentDate);
                  return (
                    <li
                      key={step.apiId}
                      className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
                    >
                      <Link
                        href={sourceStepUrl(step.apiId)}
                        className="font-medium text-emerald-900 underline-offset-4 hover:underline"
                      >
                        {step.title}
                      </Link>
                      <p className="mt-1 text-xs text-stone-500">
                        {step.institution} · {step.label}
                        {date ? ` · ${date}` : ""}
                      </p>
                      {step.document && (
                        <p className="mt-1 text-xs">
                          <Link
                            href={sourceDocumentUrl(step.document.referenceId)}
                            className="text-emerald-900 underline underline-offset-2"
                          >
                            Document {step.document.number}
                          </Link>
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="text-sm text-stone-500">
                No proceeding steps are stored.
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
