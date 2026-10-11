export type VorgangPage = {
  documents: unknown[];
  cursor: string;
  numFound: number;
};

export type FetchVorgangPage = (params: {
  wahlperiode: number;
  aktualisiertStart?: string;
  aktualisiertEnd?: string;
  cursor?: string;
}) => Promise<VorgangPage>;

export type CollectVorgangOptions = {
  runId: string;
  electoralTerm: number;
  updatedFrom?: Date;
  updatedTo?: Date;
  proceedingCap?: number;
  fetchPage: FetchVorgangPage;
};

export type CollectVorgangResult = {
  runId: string;
  status: "completed";
  valid: number;
  invalid: number;
  stored: number;
  versionsAdded: number;
  capped: number;
  replayed: boolean;
};

export type Vorgang = {
  id: string;
  typ: "Vorgang";
  vorgangstyp: string;
  wahlperiode: number;
  titel: string;
  aktualisiert: string;
  beratungsstand?: string;
  datum?: string;
};

export type StoredDoc = {
  doc: Vorgang;
  raw: Record<string, unknown>;
  index: number;
};

export type StepPage = {
  documents: unknown[];
  cursor: string;
  numFound: number;
};

export type FetchStepPage = (params: {
  wahlperiode: number;
  aktualisiertStart?: string;
  aktualisiertEnd?: string;
  cursor?: string;
}) => Promise<StepPage>;

// Single-item parent retrieval for steps whose proceeding is not stored yet.
// Returns the raw /vorgang payload, or null when the parent does not exist.
export type FetchVorgang = (id: string) => Promise<unknown | null>;

export type CollectStepsOptions = {
  runId: string;
  electoralTerm: number;
  updatedFrom?: Date;
  updatedTo?: Date;
  // When true, steps resolve against the stored proceeding set: missing
  // parents are backfilled where possible, and steps whose parents fall
  // outside the local proceeding cap are skipped but counted, never silent.
  followStoredParents?: boolean;
  proceedingCap?: number;
  // Reference date for the 14-day PDF hot subset; defaults to collection time.
  now?: Date;
  fetchPage: FetchStepPage;
  fetchVorgang?: FetchVorgang;
};

export type CollectStepsResult = {
  runId: string;
  status: "completed";
  valid: number;
  invalid: number;
  stored: number;
  versionsAdded: number;
  capped: number;
  backfilled: number;
  replayed: boolean;
};

export type Step = {
  id: string;
  typ: "Vorgangsposition";
  vorgangsposition: string;
  zuordnung: string;
  gang: boolean;
  fortsetzung: boolean;
  nachtrag: boolean;
  vorgangstyp: string;
  titel: string;
  dokumentart: string;
  vorgang_id: string;
  datum: string;
  aktualisiert: string;
  fundstelle: {
    id: string;
    dokumentnummer: string;
    datum: string;
    pdf_url?: string;
  };
  aktivitaet_anzahl: number;
};

export type StoredStep = {
  doc: Step;
  raw: Record<string, unknown>;
  fundstelleRest: Record<string, unknown>;
  index: number;
};
