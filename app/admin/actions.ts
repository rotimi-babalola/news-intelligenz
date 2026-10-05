"use server";

import { reextractPublication, retryJob } from "../../src/admin/service";
import { jobIdSchema, publicationIdSchema } from "../../src/validation";

export async function retryJobAction(formData: FormData) {
  const parsed = jobIdSchema.safeParse(formData.get("id"));
  if (!parsed.success) {
    console.error("Job retry failed:", "Missing job id");
    return;
  }
  await retryJob(parsed.data);
}

export async function reextractAction(formData: FormData) {
  const parsed = publicationIdSchema.safeParse(formData.get("id"));
  if (!parsed.success) {
    console.error("Publication re-extract failed:", "Missing publication id");
    return;
  }
  await reextractPublication(parsed.data);
}
