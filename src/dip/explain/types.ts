import type { getProceeding } from "../proceedings/timeline";
import type { searchProceedingDossiers } from "../search/dossiers";

export type Dossier = Awaited<
  ReturnType<typeof searchProceedingDossiers>
>[number];

export type BriefLanguage = "en" | "de";

export type Evidence = {
  id: string;
  text: string;
  citation: {
    kind: "step" | "page";
    stepId: string;
    url: string;
    referenceId?: string;
    page?: number;
  };
};

export type TimelineStep = NonNullable<
  Awaited<ReturnType<typeof getProceeding>>
>["steps"][number];

export const sections = [
  "matter",
  "stage",
  "steps",
  "documents",
  "unresolved",
] as const;

export type Section = (typeof sections)[number];

export type Claim = {
  text: string;
  quote: string;
  citation: Evidence["citation"];
};

export type Claims = Record<Section, Claim[]>;
