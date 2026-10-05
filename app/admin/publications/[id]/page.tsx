import Link from "next/link";
import { notFound } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { getPublication } from "../../../../src/admin/service";
import { Badge } from "../../../../src/components/ui/badge";
import { Button } from "../../../../src/components/ui/button";
import { reextractAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function PublicationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const publication = await getPublication(id);
  if (!publication) notFound();
  const latest = publication.versions[publication.versions.length - 1];
  const fullText = publication.contentAvailability === "full_text";

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900 antialiased">
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        <Link
          href="/admin#publications"
          className="text-sm font-medium text-emerald-900 underline-offset-4 hover:underline"
        >
          ← Back to collection inspection
        </Link>
        <div>
          <p className="text-xs font-semibold tracking-[0.14em] text-emerald-900">
            {publication.publisher}
          </p>
          <h1
            lang={publication.language}
            className="mt-1 text-2xl font-semibold tracking-tight"
          >
            {publication.headline}
          </h1>
          <p className="mt-2 text-sm text-stone-500">
            <a
              href={publication.originalUrl}
              rel="noreferrer"
              className="text-emerald-900 underline-offset-4 hover:underline"
            >
              Original publication
            </a>{" "}
            ·{" "}
            {publication.publishedAt
              ? new Date(publication.publishedAt).toISOString()
              : "Unknown date"}{" "}
            ·{" "}
            <Badge variant={fullText ? "success" : "secondary"}>
              {fullText
                ? `Full text · v${latest?.versionNo ?? 0}`
                : "Metadata only"}
            </Badge>
          </p>
          <form action={reextractAction} className="mt-3">
            <input type="hidden" name="id" value={publication.id} />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="gap-1.5"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Re-fetch text
            </Button>
          </form>
        </div>

        {latest ? (
          <article className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
            <p className="text-xs text-stone-400">
              Extracted text · version {latest.versionNo} of{" "}
              {publication.versions.length} · fetched{" "}
              {new Date(latest.fetchedAt).toISOString()}
            </p>
            <div className="mt-3 max-w-none text-sm leading-relaxed whitespace-pre-line">
              {latest.text}
            </div>
          </article>
        ) : (
          <div className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
            <h2 className="text-sm font-semibold">Metadata only</h2>
            <p className="mt-1 text-sm text-stone-500">
              No article text is retained for this publication.{" "}
              {publication.extractionError ?? "Extraction has not completed."}{" "}
              <a
                href={publication.originalUrl}
                rel="noreferrer"
                className="text-emerald-900 underline-offset-4 hover:underline"
              >
                Visit the original publication.
              </a>
            </p>
          </div>
        )}

        {publication.versions.length > 1 && (
          <section className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
            <h2 className="text-sm font-semibold">Version history</h2>
            <ul className="mt-2 divide-y divide-stone-100 text-sm">
              {[...publication.versions].reverse().map((v) => (
                <li key={v.id} className="py-2">
                  <span className="font-medium">Version {v.versionNo}</span>{" "}
                  <span className="text-xs text-stone-500">
                    · {v.text.length} chars · fetched{" "}
                    {new Date(v.fetchedAt).toISOString()}
                  </span>
                  <span className="block truncate text-xs text-stone-400">
                    {v.finalUrl}
                  </span>
                  <p className="mt-1 line-clamp-3 text-stone-600">
                    {v.text.slice(0, 300)}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold">Discovery history</h2>
          <ul className="mt-2 divide-y divide-stone-100 text-sm">
            {publication.discoveries.map((d) => (
              <li key={d.runId} className="py-1.5">
                <span className="font-medium">{d.run.feedId}</span>{" "}
                <span className="text-xs text-stone-500">
                  · Run {d.runId} · {new Date(d.discoveredAt).toISOString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
