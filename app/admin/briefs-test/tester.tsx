"use client";

import { useState, type FormEvent } from "react";
import { Badge } from "../../../src/components/ui/badge";
import { Button } from "../../../src/components/ui/button";
import type { generateProceedingBrief } from "../../../src/dip/explain/index";

type Brief = Awaited<ReturnType<typeof generateProceedingBrief>>;
type Result = {
  error?: string;
  candidates?: { apiId: string; title: string | null; score: number }[];
  selected?: { apiId: string; title: string | null };
  briefs?: { en: Brief; de: Brief };
  documents?: {
    stepId: string;
    referenceId: string;
    number: string | null;
    pdfUrl: string | null;
    status: string;
    reason: string | null;
    retrieved: boolean;
  }[];
};
type BriefCopy = {
  groups: readonly (readonly [keyof Brief["claims"], string])[];
  confidence: Record<Brief["answerConfidence"], string>;
  retrieval: string;
  quote: string;
  step: (id: string) => string;
  document: (id: string | undefined, page: number | undefined) => string;
  noDocument: string;
  noClaim: string;
};

const copy: Record<"en" | "de", BriefCopy> = {
  en: {
    groups: [
      ["answer", "Answer"],
      ["matter", "Matter"],
      ["stage", "Current stage"],
      ["steps", "Ordered steps"],
      ["documents", "Cited documents"],
      ["unresolved", "Unresolved"],
    ],
    confidence: {
      abstain: "abstain",
      partial: "partial",
      supported: "supported",
    },
    retrieval: "Retrieval",
    quote: "Source quote:",
    step: (id: string) => `Step ${id}`,
    document: (id: string | undefined, page: number | undefined) =>
      `Document ${id}, page ${page}`,
    noDocument: "No retrieved document page supported a claim.",
    noClaim: "No supported claim.",
  },
  de: {
    groups: [
      ["answer", "Antwort"],
      ["matter", "Gegenstand"],
      ["stage", "Aktuelles Stadium"],
      ["steps", "Geordnete Schritte"],
      ["documents", "Zitierte Dokumente"],
      ["unresolved", "Ungelöst"],
    ],
    confidence: {
      abstain: "keine Antwort",
      partial: "teilweise",
      supported: "belegt",
    },
    retrieval: "Relevanz",
    quote: "Quellenbeleg:",
    step: (id: string) => `Schritt ${id}`,
    document: (id: string | undefined, page: number | undefined) =>
      `Dokument ${id}, Seite ${page}`,
    noDocument: "Keine abgerufene Dokumentseite stützt eine Aussage.",
    noClaim: "Keine belegte Aussage.",
  },
};

export function BriefTester({
  proceedings,
}: {
  proceedings: { apiId: string; title: string }[];
}) {
  const [question, setQuestion] = useState("");
  const [apiId, setApiId] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result>({});
  const [documentRequests, setDocumentRequests] = useState<
    Record<string, string>
  >({});

  async function queueDocument(referenceId: string) {
    setDocumentRequests((current) => ({
      ...current,
      [referenceId]: "Requesting…",
    }));
    try {
      const response = await fetch(`/api/documents/${referenceId}`);
      const document = (await response.json()) as {
        error?: string;
        job?: { status: string } | null;
      };
      setDocumentRequests((current) => ({
        ...current,
        [referenceId]:
          document.error ??
          (document.job
            ? `Job ${document.job.status}. Rerun after document processing completes.`
            : "No processing job could be queued."),
      }));
    } catch {
      setDocumentRequests((current) => ({
        ...current,
        [referenceId]: "Document request failed.",
      }));
    }
  }

  async function run(selectedApiId = apiId) {
    setPending(true);
    setResult({});
    try {
      const response = await fetch("/api/test-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          ...(selectedApiId ? { apiId: selectedApiId } : {}),
        }),
      });
      setResult((await response.json()) as Result);
    } catch {
      setResult({ error: "Request failed. Try again." });
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run();
  }

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900 antialiased">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto max-w-6xl px-5 py-6">
          <a
            href="/admin"
            className="text-sm font-medium text-emerald-900 underline-offset-4 hover:underline"
          >
            ← Admin
          </a>
          <p className="mt-5 text-xs font-semibold tracking-[0.14em] text-emerald-900">
            NEWS INTELLIGENZ / LOCAL TEST
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Proceeding brief tester
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-stone-600">
            Ask a question, then inspect the English and German claims against
            their stored step or document-page evidence.
          </p>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 px-5 py-7">
        <section
          className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
          aria-labelledby="sample-heading"
        >
          <h2 id="sample-heading" className="text-lg font-semibold">
            Sample queries from your data
          </h2>
          <p className="mt-1 text-sm text-stone-500">
            Choose one to fill the form. Edit it if you want a narrower answer.
          </p>
          {proceedings.length ? (
            <div className="mt-4 grid gap-2 md:grid-cols-2">
              {proceedings.map((proceeding, index) => (
                <button
                  key={proceeding.apiId}
                  type="button"
                  onClick={() => {
                    setApiId(proceeding.apiId);
                    setQuestion(
                      index % 2 === 0
                        ? `What is the current stage of ${proceeding.title}, which steps led here, and what do the cited documents say?`
                        : `Was ist der aktuelle Beratungsstand von ${proceeding.title}, welche Schritte sind dokumentiert und was sagen die zitierten Dokumente?`,
                    );
                  }}
                  className="rounded-lg border border-stone-200 p-3 text-left text-sm transition-colors hover:border-emerald-800 hover:bg-emerald-50"
                >
                  <span className="block font-medium">{proceeding.title}</span>
                  <span className="mt-1 block text-xs text-stone-500">
                    DIP {proceeding.apiId} ·{" "}
                    {index % 2 === 0 ? "English query" : "German query"}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-stone-500">
              No stored proceedings yet. You can still enter a question below.
            </p>
          )}
        </section>

        <form
          onSubmit={submit}
          className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
        >
          <div className="grid gap-4 md:grid-cols-[1fr_13rem]">
            <div>
              <label htmlFor="question" className="block text-sm font-medium">
                Question or search query
              </label>
              <textarea
                id="question"
                name="question"
                required
                maxLength={1000}
                rows={3}
                value={question}
                onChange={(event) => {
                  setQuestion(event.target.value);
                  setApiId("");
                }}
                placeholder="What happened to the proceeding about …?"
                className="mt-2 w-full rounded-md border border-stone-300 bg-white p-3 text-sm"
              />
            </div>
            <div>
              <label htmlFor="apiId" className="block text-sm font-medium">
                Proceeding
              </label>
              <select
                id="apiId"
                name="apiId"
                value={apiId}
                onChange={(event) => setApiId(event.target.value)}
                className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Search all proceedings</option>
                {apiId && !proceedings.some((item) => item.apiId === apiId) && (
                  <option value={apiId}>Proceeding {apiId}</option>
                )}
                {proceedings.map((proceeding) => (
                  <option key={proceeding.apiId} value={proceeding.apiId}>
                    {proceeding.title}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-stone-500">
                A selected proceeding must appear in the top 20 search results.
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button type="submit" disabled={pending || !question.trim()}>
              {pending
                ? "Working…"
                : apiId
                  ? "Generate both languages"
                  : "Find proceedings"}
            </Button>
            {pending && (
              <span role="status" className="text-sm text-stone-500">
                {apiId ? "Generating briefs…" : "Searching proceedings…"}
              </span>
            )}
          </div>
        </form>

        {result.error && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          >
            {result.error}
          </p>
        )}
        {result.candidates && (
          <section
            aria-labelledby="candidates-heading"
            className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
          >
            <h2 id="candidates-heading" className="text-lg font-semibold">
              Choose a proceeding
            </h2>
            <p className="mt-1 text-sm text-stone-500">
              This tester explains one proceeding at a time. Choose a relevant
              record or refine the question.
            </p>
            <ol className="mt-4 space-y-2">
              {result.candidates.map((candidate) => (
                <li key={candidate.apiId}>
                  <button
                    type="button"
                    onClick={() => {
                      setApiId(candidate.apiId);
                      void run(candidate.apiId);
                    }}
                    className="w-full rounded-lg border border-stone-200 p-3 text-left text-sm hover:border-emerald-800 hover:bg-emerald-50"
                  >
                    <span className="block font-medium">
                      {candidate.title ?? `Proceeding ${candidate.apiId}`}
                    </span>
                    <span className="mt-1 block text-xs text-stone-500">
                      DIP {candidate.apiId} · Retrieval{" "}
                      {candidate.score.toFixed(2)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}
        {result.briefs && result.selected && (
          <section aria-labelledby="result-heading" className="space-y-4">
            <div>
              <h2 id="result-heading" className="text-xl font-semibold">
                {result.selected.title ?? `Proceeding ${result.selected.apiId}`}
              </h2>
              <p className="text-sm text-stone-500">
                DIP {result.selected.apiId} · Compare each claim with its quote
                and source.
              </p>
            </div>
            <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
              <h3 className="text-lg font-semibold">Linked PDF status</h3>
              <p className="mt-1 text-sm text-stone-600">
                A PDF link alone cannot support a document claim. The brief
                needs a processed page that the search retrieved.
              </p>
              <p className="mt-1 text-xs text-stone-500">
                After queuing a PDF locally, run the document worker (POST
                /api/drain-documents), then search again.
              </p>
              {result.documents?.length ? (
                <ul className="mt-3 space-y-2 text-sm">
                  {result.documents.map((document) => (
                    <li
                      key={document.referenceId}
                      className="rounded-md border border-stone-200 p-3"
                    >
                      <span className="font-medium">
                        Step {document.stepId} ·{" "}
                        {document.number ?? `Document ${document.referenceId}`}
                      </span>
                      <span className="ml-2 text-stone-600">
                        {document.status === "available"
                          ? document.retrieved
                            ? "Processed; page retrieved"
                            : "Processed; no page retrieved for this query"
                          : document.status === "metadata-only"
                            ? `Metadata only: ${document.reason}`
                            : "PDF not processed"}
                      </span>
                      {document.pdfUrl && (
                        <a
                          href={document.pdfUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-2 text-emerald-900 underline"
                        >
                          Open PDF
                        </a>
                      )}
                      {document.status === "unavailable" && (
                        <button
                          type="button"
                          onClick={() =>
                            void queueDocument(document.referenceId)
                          }
                          className="ml-2 text-emerald-900 underline"
                        >
                          Queue PDF processing
                        </button>
                      )}
                      {documentRequests[document.referenceId] && (
                        <p role="status" className="mt-1 text-stone-600">
                          {documentRequests[document.referenceId]}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-stone-500">
                  No PDF references are linked to this proceeding.
                </p>
              )}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {(["en", "de"] as const).map((language) => {
                const brief = result.briefs![language];
                const labels = copy[language];
                return (
                  <article
                    key={language}
                    lang={language}
                    className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold">
                        {language === "en" ? "English" : "Deutsch"}
                      </h3>
                      <Badge
                        variant={
                          brief.answerConfidence === "abstain"
                            ? "warning"
                            : "outline"
                        }
                      >
                        {labels.confidence[brief.answerConfidence]}
                      </Badge>
                      <span className="text-xs text-stone-500">
                        {labels.retrieval} {brief.retrievalRelevance.toFixed(2)}
                      </span>
                    </div>
                    {brief.qualification && (
                      <p className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
                        {brief.qualification}
                      </p>
                    )}
                    {labels.groups.map(([key, label]) => (
                      <section key={key} className="mt-5">
                        <h4 className="text-sm font-semibold">{label}</h4>
                        {brief.claims[key].length ? (
                          <ul className="mt-2 space-y-3">
                            {brief.claims[key].map((claim, index) => (
                              <li
                                key={`${key}-${index}`}
                                className="border-l-2 border-emerald-800 pl-3 text-sm"
                              >
                                <p>{claim.text}</p>
                                <p className="mt-1 text-xs text-stone-500">
                                  {labels.quote} <q>{claim.quote}</q>
                                </p>
                                <a
                                  href={claim.citation.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 inline-block text-xs font-medium text-emerald-900 underline underline-offset-2"
                                >
                                  {claim.citation.kind === "page"
                                    ? labels.document(
                                        claim.citation.referenceId,
                                        claim.citation.page,
                                      )
                                    : labels.step(claim.citation.stepId)}
                                </a>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mt-1 text-sm text-stone-500">
                            {key === "documents"
                              ? labels.noDocument
                              : labels.noClaim}
                          </p>
                        )}
                      </section>
                    ))}
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
