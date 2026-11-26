import type { Metadata } from "next";
import Link from "next/link";
import styles from "../reader.module.css";

export const metadata: Metadata = {
  title: "Klarantwort",
  robots: { index: false, follow: false },
};

const copy = {
  en: {
    title: "The answer page is being built.",
    note: "The landing flow is in place. The cited answer will render here in the next step.",
    questionLabel: "Your question",
    selected: "A proceeding was selected.",
    missing: "No question was provided.",
    back: "Ask another question",
  },
  de: {
    title: "Die Antwortseite wird gerade gebaut.",
    note: "Der Ablauf von der Startseite ist fertig. Die belegte Antwort erscheint hier im nächsten Schritt.",
    questionLabel: "Ihre Frage",
    selected: "Ein Vorgang wurde ausgewählt.",
    missing: "Es wurde keine Frage übergeben.",
    back: "Eine andere Frage stellen",
  },
} as const;

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}

export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string | string[];
    p?: string | string[];
    l?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const question = single(params.q)?.trim() ?? "";
  const hasProceeding = /^\d+$/.test(single(params.p) ?? "");
  const language = single(params.l) === "de" ? "de" : "en";
  const t = copy[language];

  return (
    <div className={styles.page} lang={language}>
      <header className={styles.navShell}>
        <div className={`${styles.container} ${styles.nav}`}>
          <Link className={styles.brand} href="/">
            Klarantwort
          </Link>
        </div>
      </header>

      <main className={`${styles.container} ${styles.stub}`}>
        <h1 className={styles.stubTitle}>{t.title}</h1>
        <p className={styles.stubNote}>{t.note}</p>

        {question ? (
          <>
            <p className={styles.stubLabel}>{t.questionLabel}</p>
            <p className={styles.stubQuestion}>{question}</p>
          </>
        ) : (
          <p className={styles.stubMeta}>{t.missing}</p>
        )}

        {hasProceeding ? <p className={styles.stubMeta}>{t.selected}</p> : null}

        <Link className={styles.backLink} href="/">
          {t.back}
        </Link>
      </main>
    </div>
  );
}
