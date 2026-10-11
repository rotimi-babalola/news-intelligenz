import { createHash } from "node:crypto";
import { z } from "zod";
import type { StoredDoc, Vorgang } from "./types";

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
