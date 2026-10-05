import { z } from "zod";
import { isHttpUrl } from "./sources";

// Request boundaries speak untyped JSON/FormData/query strings; services
// speak typed TypeScript. These schemas sit at that boundary only — service
// functions keep their own guards for direct (typed) callers.
export const runIdSchema = z.string().trim().min(1).max(200);

export const runPrefixSchema = z.string().trim().min(1).max(100);

export const feedUrlSchema = z
  .string()
  .refine((value) => value === "" || isHttpUrl(value), {
    message: "feedUrl must be an absolute HTTP(S) URL",
  })
  .optional();

export const jobIdSchema = z.string().uuid();

export const publicationIdSchema = z.string().uuid();
