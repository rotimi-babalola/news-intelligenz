"use client";

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@ui-sdk/react/command";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../reader.module.css";

type Language = "en" | "de";

type Candidate = {
  apiId: string;
  title: string | null;
  type: string | null;
  deliberationState: string | null;
  lastActivity: string | null;
};

type SelectResponse =
  | { kind: "selected"; proceeding: Candidate }
  | { kind: "candidates"; candidates: Candidate[] }
  | { error: { code: string; message: string } };

type ErrorCode =
  | "empty"
  | "network"
  | "no_match"
  | "invalid_request"
  | "forbidden"
  | "proceeding_missing"
  | "search_failed";

const errorCodes = new Set<ErrorCode>([
  "no_match",
  "invalid_request",
  "forbidden",
  "proceeding_missing",
  "search_failed",
]);

const LANGUAGE_KEY = "klarantwort.language";

const copy = {
  en: {
    languageLabel: "Language",
    title: "Understand what the Bundestag is deciding.",
    lede: "Ask in German or English, and every answer cites the official record.",
    label: "Your question",
    placeholder: "Type your question",
    submit: "Ask",
    searchingButton: "Searching",
    examplesLabel: "Or start with one of these",
    examples: [
      "Which plans aim to lower housing costs?",
      "How should electricity grid charges be reorganised from 2029?",
      "How many people with a migration background joined employment support measures in 2024?",
    ],
    searching: "Searching proceedings…",
    chooseStatus: (count: number) =>
      count === 1
        ? "1 proceeding matches. Choose it."
        : `${count} proceedings match. Choose one.`,
    pickerTitle: "Choose the proceeding",
    recordNote:
      "Official record titles, types and statuses are shown in German. Your answer will be in English.",
    searchProceedings: "Search proceedings",
    noCandidate: "No proceeding matches.",
    close: "Close",
    retry: "Try again",
    untitled: "Untitled proceeding",
    errors: {
      empty: "Enter a question first.",
      network: "The search is unavailable right now. Try again.",
      no_match: "No proceeding matched this question. Try different words.",
      invalid_request: "Enter a question of up to 1,000 characters.",
      forbidden: "Search is only available from this local page.",
      proceeding_missing: "The proceeding record for this timeline is missing.",
      search_failed: "The search failed. Try again.",
    },
    footer: "Answers grounded in official DIP records.",
  },
  de: {
    languageLabel: "Sprache",
    title: "Verstehen, was der Bundestag entscheidet.",
    lede: "Fragen Sie auf Deutsch oder Englisch, und jede Antwort nennt die amtliche Quelle.",
    label: "Ihre Frage",
    placeholder: "Frage eingeben",
    submit: "Fragen",
    searchingButton: "Suche läuft",
    examplesLabel: "Oder beginnen Sie mit einer dieser Fragen",
    examples: [
      "Welche Vorhaben sollen die Baukosten für Wohnungen senken?",
      "Wie sollen die Stromnetzentgelte ab 2029 neu geordnet werden?",
      "Wie nahmen Menschen mit Migrationshintergrund 2024 an Arbeitsförderung teil?",
    ],
    searching: "Vorgänge werden durchsucht…",
    chooseStatus: (count: number) =>
      count === 1
        ? "1 Vorgang passt. Wählen Sie ihn aus."
        : `${count} Vorgänge passen. Wählen Sie einen aus.`,
    pickerTitle: "Vorgang auswählen",
    searchProceedings: "Vorgänge durchsuchen",
    noCandidate: "Kein Vorgang passt.",
    close: "Schließen",
    retry: "Erneut versuchen",
    untitled: "Vorgang ohne Titel",
    errors: {
      empty: "Geben Sie zuerst eine Frage ein.",
      network:
        "Die Suche ist gerade nicht erreichbar. Versuchen Sie es erneut.",
      no_match:
        "Kein Vorgang passt zu dieser Frage. Versuchen Sie andere Wörter.",
      invalid_request: "Geben Sie eine Frage mit höchstens 1.000 Zeichen ein.",
      forbidden: "Die Suche ist nur auf dieser lokalen Seite verfügbar.",
      proceeding_missing: "Der Vorgang zu dieser Chronologie fehlt.",
      search_failed: "Die Suche ist fehlgeschlagen. Versuchen Sie es erneut.",
    },
    footer: "Antworten auf Grundlage amtlicher DIP-Datensätze.",
  },
} as const;

function formatDate(value: string, language: Language) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
    dateStyle: "medium",
  }).format(date);
}

function candidateLabel(
  candidate: Candidate,
  t: (typeof copy)[Language],
  language: Language,
) {
  return [
    candidate.title ?? t.untitled,
    candidate.type,
    candidate.deliberationState,
    candidate.lastActivity
      ? formatDate(candidate.lastActivity, language)
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function Landing() {
  const router = useRouter();
  const [language, setLanguage] = useState<Language>("en");
  const [question, setQuestion] = useState("");
  const [phase, setPhase] = useState<"idle" | "searching">("idle");
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);
  const [candidateList, setCandidateList] = useState<Candidate[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const composingRef = useRef(false);
  const questionValue = useRef(question);
  const languageValue = useRef(language);
  questionValue.current = question;
  languageValue.current = language;
  const t = copy[language];
  const error = errorCode ? t.errors[errorCode] : null;
  const statusText = phase === "searching" ? t.searching : "";

  useEffect(() => {
    document.documentElement.lang = language;
    return () => {
      document.documentElement.lang = "en";
    };
  }, [language]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LANGUAGE_KEY);
      if (stored === "en" || stored === "de") setLanguage(stored);
    } catch {
      // Storage can be unavailable in private or embedded contexts.
    }
  }, []);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const goToAnswer = useCallback(
    (candidate: Candidate) => {
      const params = new URLSearchParams({
        q: questionValue.current.trim(),
        p: candidate.apiId,
        l: languageValue.current,
      });
      router.push(`/ask?${params.toString()}`);
    },
    [router],
  );

  const search = useCallback(
    async (query: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setErrorCode(null);
      setCandidateList(null);
      setPickerOpen(false);
      setPhase("searching");

      try {
        const response = await fetch("/api/select", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: query }),
          signal: controller.signal,
        });
        const payload = (await response
          .json()
          .catch(() => null)) as SelectResponse | null;

        if (!response.ok || !payload || "error" in payload) {
          const code =
            payload && "error" in payload
              ? payload.error.code
              : "search_failed";
          setErrorCode(
            errorCodes.has(code as ErrorCode)
              ? (code as ErrorCode)
              : "search_failed",
          );
          setPhase("idle");
          return;
        }

        if (payload.kind === "candidates") {
          setCandidateList(payload.candidates);
          setPickerOpen(true);
          setPhase("idle");
          return;
        }

        setPhase("idle");
        goToAnswer(payload.proceeding);
      } catch (cause) {
        if (
          controller.signal.aborted ||
          (cause instanceof DOMException && cause.name === "AbortError")
        )
          return;
        setErrorCode("network");
        setPhase("idle");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [goToAnswer],
  );

  const updateQuestion = (value: string) => {
    setQuestion(value);
    if (errorCode) setErrorCode(null);
    if (phase === "searching") {
      abortRef.current?.abort();
      setPhase("idle");
    }
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (composingRef.current) return;
    const query = question.trim();
    if (!query) {
      setErrorCode("empty");
      inputRef.current?.focus();
      return;
    }
    void search(query);
  };

  const handleRetry = () => {
    const query = question.trim();
    if (!query) {
      setErrorCode("empty");
      inputRef.current?.focus();
      return;
    }
    void search(query);
  };

  const chooseLanguage = (next: Language) => {
    setLanguage(next);
    try {
      window.localStorage.setItem(LANGUAGE_KEY, next);
    } catch {
      // The toggle still works for this page without storage.
    }
  };

  const handlePickerOpenChange = (open: boolean) => {
    setPickerOpen(open);
    if (!open) {
      setCandidateList(null);
      setPhase("idle");
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.navShell}>
        <div className={`${styles.container} ${styles.nav}`}>
          <a className={styles.brand} href="#top">
            Klarantwort
          </a>
          <div
            className={styles.lang}
            role="group"
            aria-label={t.languageLabel}
          >
            <button
              type="button"
              aria-pressed={language === "en"}
              onClick={() => chooseLanguage("en")}
            >
              EN
            </button>
            <button
              type="button"
              aria-pressed={language === "de"}
              onClick={() => chooseLanguage("de")}
            >
              DE
            </button>
          </div>
        </div>
      </header>

      <main id="top">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.container}>
            <h1 id="hero-title" className={styles.title}>
              {t.title}
            </h1>
            <p className={styles.lede}>{t.lede}</p>

            <form
              className={styles.form}
              noValidate
              aria-busy={phase === "searching"}
              onSubmit={handleSubmit}
            >
              <label className={styles.label} htmlFor="question">
                {t.label}
              </label>
              <div className={styles.askRow}>
                <input
                  ref={inputRef}
                  className={styles.input}
                  id="question"
                  name="question"
                  type="text"
                  maxLength={1000}
                  autoComplete="off"
                  spellCheck={false}
                  value={question}
                  placeholder={t.placeholder}
                  onChange={(event) => updateQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (composingRef.current || event.nativeEvent.isComposing)
                    )
                      event.preventDefault();
                  }}
                  onCompositionStart={() => {
                    composingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    composingRef.current = false;
                  }}
                />
                <button
                  className={styles.submit}
                  type="submit"
                  disabled={phase === "searching"}
                >
                  {phase === "searching" ? t.searchingButton : t.submit}
                </button>
              </div>

              <p className={styles.status} role="status" aria-live="polite">
                {statusText}
              </p>
              {error ? (
                <div className={styles.error} role="alert">
                  <span>{error}</span>
                  <button
                    className={styles.retry}
                    type="button"
                    onClick={handleRetry}
                    disabled={phase === "searching"}
                  >
                    {t.retry}
                  </button>
                </div>
              ) : null}
            </form>

            <div className={styles.examples}>
              <p className={styles.examplesLabel}>{t.examplesLabel}</p>
              <ul className={styles.exampleList}>
                {t.examples.map((example) => (
                  <li key={example}>
                    <button
                      className={styles.example}
                      type="button"
                      onClick={() => {
                        updateQuestion(example);
                        inputRef.current?.focus();
                      }}
                    >
                      {example}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerInner}`}>
          <p className={styles.footerBrand}>Klarantwort</p>
          <p className={styles.footerLine}>{t.footer}</p>
        </div>
      </footer>

      <Dialog open={pickerOpen} onOpenChange={handlePickerOpenChange}>
        <DialogBackdrop className={styles.backdrop} />
        {candidateList?.length ? (
          <DialogContent
            className={styles.dialog}
            initialFocus="input"
            finalFocus={() => inputRef.current}
          >
            <div className={styles.dialogHeader}>
              <div>
                <DialogTitle className={styles.dialogTitle}>
                  {t.pickerTitle}
                </DialogTitle>
                <DialogDescription className={styles.dialogDescription}>
                  {t.chooseStatus(candidateList.length)}
                </DialogDescription>
              </div>
              <DialogClose className={styles.close} aria-label={t.close}>
                <X aria-hidden="true" size={18} />
              </DialogClose>
            </div>

            <p className={styles.dialogQuestion}>
              <span className={styles.dialogQuestionLabel}>{t.label}</span>
              <span className={styles.dialogQuestionText}>{question}</span>
            </p>
            {language === "en" ? (
              <p className={styles.dialogNote}>{copy.en.recordNote}</p>
            ) : null}

            <Command
              className={styles.command}
              filter="contains"
              autoHighlight
              announcement={(change) => {
                if (change.type !== "results") return null;
                if (change.loading)
                  return language === "de" ? "Wird geladen" : "Loading";
                if (!change.count)
                  return language === "de" ? "Keine Treffer" : "No results";
                return language === "de"
                  ? `${change.count} ${change.count === 1 ? "Vorgang" : "Vorgänge"}`
                  : `${change.count} ${change.count === 1 ? "proceeding" : "proceedings"}`;
              }}
              onAction={(value) => {
                const candidate = candidateList.find(
                  (item) => item.apiId === value,
                );
                if (candidate) goToAnswer(candidate);
              }}
            >
              <CommandInput
                className={styles.commandInput}
                aria-label={t.searchProceedings}
                placeholder={t.searchProceedings}
              />
              <CommandEmpty className={styles.commandEmpty}>
                {t.noCandidate}
              </CommandEmpty>
              <CommandList
                className={styles.commandList}
                aria-label={t.pickerTitle}
              >
                {candidateList.map((candidate) => (
                  <CommandItem
                    key={candidate.apiId}
                    className={styles.commandItem}
                    value={candidate.apiId}
                    label={candidateLabel(candidate, t, language)}
                  >
                    <span className={styles.candidateTitle}>
                      {candidate.title ?? t.untitled}
                    </span>
                    {candidate.type ||
                    candidate.deliberationState ||
                    candidate.lastActivity ? (
                      <span className={styles.candidateMeta}>
                        {candidate.type ? <span>{candidate.type}</span> : null}
                        {candidate.deliberationState ? (
                          <span>{candidate.deliberationState}</span>
                        ) : null}
                        {candidate.lastActivity ? (
                          <span>
                            {formatDate(candidate.lastActivity, language)}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
