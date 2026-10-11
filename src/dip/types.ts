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
