import {
  PROCEEDING_SELECTION_EVIDENCE_FLOOR,
  PROCEEDING_SELECTION_EVIDENCE_GAP,
} from "../constants";
import type { Dossier } from "../explain/types";

export type ProceedingSelection =
  | { kind: "selected"; dossier: Dossier }
  | { kind: "candidates"; dossiers: Dossier[] };

// Dossiers arrive in search order. Orphan timelines have no proceeding to
// answer from, so they stay out of auto-selection and the candidate list.
// The query is part of the route's call shape; the decision is score-only so
// the same dossiers always select the same proceeding.
export function selectProceeding(
  dossiers: Dossier[],
  _query: string,
): ProceedingSelection {
  const answerable = dossiers.filter((dossier) => !dossier.parentMissing);
  const best = answerable[0];
  // Ambiguity is about evidence, not the ranking tie-breakers: a lower-ranked
  // dossier can hold stronger evidence than the runner-up.
  const rivalEvidence = Math.max(
    0,
    ...answerable.slice(1).map((dossier) => dossier.ranking.strongestEvidence),
  );
  const evidenceGap = best ? best.ranking.strongestEvidence - rivalEvidence : 0;
  if (
    best &&
    best.ranking.strongestEvidence >= PROCEEDING_SELECTION_EVIDENCE_FLOOR &&
    evidenceGap >= PROCEEDING_SELECTION_EVIDENCE_GAP
  )
    return { kind: "selected", dossier: best };
  return { kind: "candidates", dossiers: answerable };
}
