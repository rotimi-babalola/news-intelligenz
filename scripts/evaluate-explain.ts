import { readFile } from "node:fs/promises";
import { z } from "zod";
import { database } from "../src/db.js";
import { MIN_CLAIM_QUOTE_LENGTH } from "../src/dip/constants.js";
import {
  collectEvidence,
  loadDocumentVariants,
  matchesDossier,
} from "../src/dip/explain/evidence.js";
import {
  citationEvidenceId,
  isEvidenceId,
  meanScore,
  scoreAnswer,
  type AnswerLabel,
  type FailureCause,
  type ScoredAnswer,
} from "../src/dip/explain/evaluate.js";
import { generateProceedingBrief } from "../src/dip/explain/generate.js";
import { explainConfiguration } from "../src/dip/explain/provider.js";
import type { Dossier } from "../src/dip/explain/types.js";
import { getProceeding } from "../src/dip/proceedings/timeline.js";
import { searchProceedingDossiers } from "../src/dip/search/dossiers.js";

const DOSSIER_LIMIT = 5;

const fact = z.object({
  text: z.string().trim().min(1),
  terms: z.array(z.string().trim().min(1)).min(1),
  evidenceIds: z
    .array(
      z.string().refine(isEvidenceId, "Use step:<id> or page:<reference>:<n>"),
    )
    .min(1),
  quote: z.string().trim().min(MIN_CLAIM_QUOTE_LENGTH),
});
const labels = z.object({
  reviewed: z.literal(true),
  cases: z
    .array(
      z
        .object({
          question: z.string().trim().min(1),
          language: z.enum(["en", "de"]),
          proceeding: z.string().min(1).optional(),
          expectAbstain: z.boolean().default(false),
          expectMissing: z.array(z.string().trim().min(1)).default([]),
          facts: z.array(fact).default([]),
        })
        .superRefine((value, ctx) => {
          if (
            value.expectAbstain &&
            (value.facts.length || value.expectMissing.length)
          )
            ctx.addIssue({
              code: "custom",
              message:
                "Abstention cases cannot carry expected facts or missing facts",
            });
          if (
            !value.expectAbstain &&
            !value.facts.length &&
            !value.expectMissing.length
          )
            ctx.addIssue({
              code: "custom",
              message:
                "Answerable cases need expected facts or expected missing facts",
            });
          if (!value.expectAbstain && !value.proceeding)
            ctx.addIssue({
              code: "custom",
              message: "Answerable cases need a proceeding ID",
            });
        }),
    )
    .min(1),
});

const path = process.argv[2] === "--" ? process.argv[3] : process.argv[2];
if (!path)
  throw new Error("Usage: pnpm evaluate:explain -- path/to/labels.json");
const { cases } = labels.parse(JSON.parse(await readFile(path, "utf8")));
const prisma = database();

function retrievedIds(dossier: Dossier) {
  return dossier.evidence.flatMap((hit) => {
    if (hit.entity === "dokument")
      return hit.page
        ? [
            citationEvidenceId({
              kind: "page",
              stepId: hit.source.apiId,
              referenceId: hit.document.referenceId,
              page: hit.page,
              url: hit.source.url,
            }),
          ]
        : [];
    if (hit.entity === "vorgangsposition")
      return [
        citationEvidenceId({
          kind: "step",
          stepId: hit.apiId,
          url: hit.source.url,
        }),
      ];
    return [];
  });
}

function corpusOf(
  current: NonNullable<Awaited<ReturnType<typeof getProceeding>>>,
  { documentVersions }: Awaited<ReturnType<typeof collectEvidence>>,
) {
  return {
    proceedingVersionNo: current.proceeding?.versionNo ?? null,
    steps: current.steps.map((step) => ({
      apiId: step.apiId,
      versionNo: step.versionNo,
    })),
    documents: documentVersions.map(([referenceId, byteHash, pdfUrl]) => ({
      referenceId,
      byteHash,
      pdfUrl,
    })),
  };
}

type Notice = "proceeding not retrieved" | "no dossier retrieved";

type CaseResult = {
  question: string;
  language: AnswerLabel["language"];
  expectAbstain: boolean;
  expectMissing: string[];
  proceeding: string | null;
  parentMissing: boolean | null;
  corpus: ReturnType<typeof corpusOf> | null;
  answer: Awaited<ReturnType<typeof generateProceedingBrief>> | null;
  notice: Notice | null;
  scores: ScoredAnswer | null;
};

function unscored(
  label: AnswerLabel,
  {
    proceeding,
    notice,
    abstained,
    correctAbstention,
  }: {
    proceeding: string | null;
    notice: Notice;
    abstained: boolean;
    correctAbstention: boolean;
  },
): CaseResult {
  return {
    question: label.question,
    language: label.language,
    expectAbstain: label.expectAbstain,
    expectMissing: label.expectMissing ?? [],
    proceeding,
    parentMissing: null,
    corpus: null,
    answer: null,
    notice,
    scores: {
      facts: label.facts.map((fact) => ({
        ...fact,
        covered: false,
        cited: false,
        cause: "retrieval" as const,
      })),
      factualCoverage: label.facts.length ? 0 : null,
      citationSupport: label.facts.length ? 0 : null,
      abstained,
      correctAbstention,
      qualified: false,
    },
  };
}

function summarize(results: CaseResult[]) {
  const facts = results.flatMap((result) => result.scores?.facts ?? []);
  const abstentionCases = results.filter((result) => result.expectAbstain);
  const qualificationCases = results.filter(
    (result) => result.expectMissing.length > 0,
  );
  const answerableCases = results.filter(
    (result) => !result.expectAbstain && !result.expectMissing.length,
  );
  return {
    cases: results.length,
    facts: facts.length,
    coveredFacts: facts.filter((item) => item.covered).length,
    citedFacts: facts.filter((item) => item.cited).length,
    factualCoverage: meanScore(
      results.map((result) => result.scores?.factualCoverage ?? null),
    ),
    citationSupport: meanScore(
      results.map((result) => result.scores?.citationSupport ?? null),
    ),
    abstentionAccuracy: meanScore(
      abstentionCases.map((result) =>
        result.scores ? (result.scores.correctAbstention ? 1 : 0) : null,
      ),
    ),
    qualificationAccuracy: meanScore(
      qualificationCases.map((result) =>
        result.scores ? (result.scores.qualified ? 1 : 0) : null,
      ),
    ),
    answerRate: meanScore(
      answerableCases.map((result) =>
        result.scores
          ? result.answer && !result.scores.abstained
            ? 1
            : 0
          : null,
      ),
    ),
    abstentionCases: abstentionCases.map((result) => ({
      language: result.language,
      question: result.question,
      correct: result.scores?.correctAbstention ?? null,
    })),
    qualificationCases: qualificationCases.map((result) => ({
      language: result.language,
      question: result.question,
      correct: result.scores?.qualified ?? null,
    })),
  };
}

function insufficientAnswerCause(result: CaseResult): FailureCause {
  if (
    result.notice === "proceeding not retrieved" ||
    result.notice === "no dossier retrieved"
  )
    return "retrieval";
  return result.parentMissing ? "dossier" : "synthesis";
}

try {
  const results: CaseResult[] = [];
  for (const label of cases) {
    const dossiers = await searchProceedingDossiers(
      prisma,
      label.question,
      DOSSIER_LIMIT,
    );
    const dossier = label.proceeding
      ? dossiers.find((item) => item.apiId === label.proceeding)
      : dossiers[0];
    if (label.proceeding && !dossier) {
      results.push(
        unscored(label, {
          proceeding: label.proceeding,
          notice: "proceeding not retrieved",
          abstained: false,
          correctAbstention: false,
        }),
      );
      continue;
    }
    if (!dossier) {
      results.push(
        unscored(label, {
          proceeding: null,
          notice: "no dossier retrieved",
          abstained: true,
          correctAbstention: label.expectAbstain,
        }),
      );
      continue;
    }
    const current = await getProceeding(prisma, dossier.apiId);
    if (!current || !matchesDossier(current, dossier))
      throw new Error(`Dossier changed before evaluation: ${dossier.apiId}`);
    const evidence = await collectEvidence(
      prisma,
      current,
      dossier,
      await loadDocumentVariants(prisma, dossier),
    );
    const answer = await generateProceedingBrief(prisma, {
      question: label.question,
      language: label.language,
      dossier,
    });
    results.push({
      question: label.question,
      language: label.language,
      expectAbstain: label.expectAbstain,
      expectMissing: label.expectMissing ?? [],
      proceeding: dossier.apiId,
      parentMissing: dossier.parentMissing,
      corpus: corpusOf(current, evidence),
      answer,
      notice: null,
      scores: scoreAnswer(label, answer, {
        retrieved: retrievedIds(dossier),
        collected: evidence.evidence.map((item) => item.id),
      }),
    });
  }

  const failures = results.flatMap((result) => {
    const factFailures = (result.scores?.facts ?? [])
      .filter((item) => item.cause)
      .map((item) => ({
        kind: "fact",
        cause: item.cause,
        language: result.language,
        question: result.question,
        answer: result.answer,
        expected: {
          text: item.text,
          evidenceIds: item.evidenceIds,
          quote: item.quote,
        },
      }));
    const abstentionFailure = result.scores?.correctAbstention
      ? []
      : [
          {
            kind: "abstention",
            cause: insufficientAnswerCause(result),
            language: result.language,
            question: result.question,
            answer: result.answer,
            expected: result.expectAbstain ? "abstain" : "answer",
            notice: result.notice,
          },
        ];
    const qualificationFailure =
      result.expectMissing.length && !result.scores?.qualified
        ? [
            {
              kind: "qualification",
              cause: insufficientAnswerCause(result),
              language: result.language,
              question: result.question,
              answer: result.answer,
              expected: result.expectMissing,
              notice: result.notice,
            },
          ]
        : [];
    return [...factFailures, ...abstentionFailure, ...qualificationFailure];
  });

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        configuration: explainConfiguration(),
        searchLimit: DOSSIER_LIMIT,
        results: {
          all: summarize(results),
          en: summarize(results.filter((result) => result.language === "en")),
          de: summarize(results.filter((result) => result.language === "de")),
        },
        cases: results,
        failures,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
