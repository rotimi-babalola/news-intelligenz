import { createHash } from "node:crypto";
import { z } from "zod";
import type { Step, StoredDoc, StoredStep, Vorgang } from "./types";

// OpenAPI v1.5 required fields for a proceeding; anything else rides along in
// metadata untouched.
const vorgangSchema = z.object({
  id: z.string().regex(/^\d+$/),
  typ: z.literal("Vorgang"),
  vorgangstyp: z.string().min(1),
  wahlperiode: z.number().int(),
  titel: z.string().min(1),
  aktualisiert: z.string().min(1),
  beratungsstand: z.string().optional(),
  datum: z.string().optional(),
});

const KNOWN_KEYS = new Set([
  "id",
  "typ",
  "vorgangstyp",
  "wahlperiode",
  "titel",
  "aktualisiert",
  "beratungsstand",
  "datum",
]);

export function toStored(
  input: unknown,
  index: number,
): StoredDoc | { error: string; index: number } {
  const parsed = vorgangSchema.safeParse(input);
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "invalid", index };
  const doc: Vorgang = parsed.data;
  if (Number.isNaN(Date.parse(doc.aktualisiert)))
    return { error: "unusable aktualisiert timestamp", index };
  if (doc.datum !== undefined && Number.isNaN(Date.parse(doc.datum)))
    return { error: "unusable datum", index };
  const raw = (input ?? {}) as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw))
    if (!KNOWN_KEYS.has(key)) rest[key] = value;
  return { doc, raw: rest, index };
}

export function contentHash(doc: Vorgang, rest: Record<string, unknown>) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: doc.id,
        titel: doc.titel,
        vorgangstyp: doc.vorgangstyp,
        wahlperiode: doc.wahlperiode,
        beratungsstand: doc.beratungsstand ?? null,
        datum: doc.datum ?? null,
        aktualisiert: doc.aktualisiert,
        rest,
      }),
    )
    .digest("hex");
}

export function scopeInputHash(
  endpoint: string,
  options: {
    electoralTerm: number;
    updatedFrom?: Date;
    updatedTo?: Date;
    proceedingCap?: number;
    followStoredParents?: boolean;
  },
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        endpoint,
        electoralTerm: options.electoralTerm,
        from: options.updatedFrom?.toISOString() ?? null,
        to: options.updatedTo?.toISOString() ?? null,
        cap: options.proceedingCap ?? null,
        // Only present for step collection; proceeding hashes stay stable.
        ...(options.followStoredParents === undefined
          ? {}
          : { followStoredParents: options.followStoredParents }),
      }),
    )
    .digest("hex");
}

export function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "P2002"
  );
}

// PDF background set: references whose document date falls in the previous 14
// days. Older references wait for an on-demand request (later slice); the
// document date is never a sync filter, only this queue selection.
const HOT_DOCUMENT_MS = 14 * 24 * 60 * 60 * 1000;

export function isHotDocument(documentDate: Date, now: Date) {
  const ageMs = now.getTime() - documentDate.getTime();
  return ageMs >= 0 && ageMs <= HOT_DOCUMENT_MS;
}

const INSTITUTIONS = new Set(["BT", "BR", "BV", "EK"]);

const fundstelleSchema = z.object({
  id: z.string().regex(/^\d+$/),
  dokumentnummer: z.string().min(1),
  datum: z.string().min(1),
  pdf_url: z.string().optional(),
});

const stepSchema = z.object({
  id: z.string().regex(/^\d+$/),
  typ: z.literal("Vorgangsposition"),
  vorgangsposition: z.string().min(1),
  // Institution labels are closed by the contract; anything else is an
  // invalid document, retained inspectably rather than stored wrongly.
  zuordnung: z.string().refine((value) => INSTITUTIONS.has(value), {
    message: "unknown zuordnung",
  }),
  gang: z.boolean(),
  fortsetzung: z.boolean(),
  nachtrag: z.boolean(),
  vorgangstyp: z.string().min(1),
  titel: z.string().min(1),
  dokumentart: z.enum(["Drucksache", "Plenarprotokoll"]),
  vorgang_id: z.string().regex(/^\d+$/),
  datum: z.string().min(1),
  aktualisiert: z.string().min(1),
  fundstelle: fundstelleSchema,
  aktivitaet_anzahl: z.number().int().min(0),
});

const STEP_KNOWN_KEYS = new Set([
  "id",
  "typ",
  "vorgangsposition",
  "zuordnung",
  "gang",
  "fortsetzung",
  "nachtrag",
  "vorgangstyp",
  "titel",
  "dokumentart",
  "vorgang_id",
  "datum",
  "aktualisiert",
  "fundstelle",
  "aktivitaet_anzahl",
]);

const FUNDSTELLE_KNOWN_KEYS = new Set([
  "id",
  "dokumentnummer",
  "datum",
  "pdf_url",
]);

export function toStoredStep(
  input: unknown,
  index: number,
): StoredStep | { error: string; index: number } {
  const parsed = stepSchema.safeParse(input);
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "invalid", index };
  const doc: Step = {
    ...parsed.data,
    fundstelle: { ...parsed.data.fundstelle },
  };
  if (Number.isNaN(Date.parse(doc.aktualisiert)))
    return { error: "unusable aktualisiert timestamp", index };
  if (Number.isNaN(Date.parse(doc.datum)))
    return { error: "unusable datum", index };
  if (Number.isNaN(Date.parse(doc.fundstelle.datum)))
    return { error: "unusable fundstelle datum", index };
  const raw = (input ?? {}) as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw))
    if (!STEP_KNOWN_KEYS.has(key)) rest[key] = value;
  // aktivitaet_anzeige is display-only (first four) and rides in metadata;
  // aktivitaet_anzahl is the total and must never be read as coverage.
  const fundstelleRaw =
    (raw["fundstelle"] as Record<string, unknown> | undefined) ?? {};
  const fundstelleRest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fundstelleRaw))
    if (!FUNDSTELLE_KNOWN_KEYS.has(key)) fundstelleRest[key] = value;
  return { doc, raw: rest, fundstelleRest, index };
}

export function stepContentHash(
  doc: Step,
  rest: Record<string, unknown>,
  fundstelleRest: Record<string, unknown>,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: doc.id,
        vorgangsposition: doc.vorgangsposition,
        zuordnung: doc.zuordnung,
        gang: doc.gang,
        fortsetzung: doc.fortsetzung,
        nachtrag: doc.nachtrag,
        vorgangstyp: doc.vorgangstyp,
        titel: doc.titel,
        dokumentart: doc.dokumentart,
        vorgang_id: doc.vorgang_id,
        datum: doc.datum,
        aktualisiert: doc.aktualisiert,
        fundstelle: { ...doc.fundstelle, ...fundstelleRest },
        aktivitaet_anzahl: doc.aktivitaet_anzahl,
        rest,
      }),
    )
    .digest("hex");
}
