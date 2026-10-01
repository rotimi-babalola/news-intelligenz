"use server";

import { retryJob } from "../../src/admin/service";
import { jobIdSchema } from "../../src/validation";

export async function retryJobAction(formData: FormData) {
  const parsed = jobIdSchema.safeParse(formData.get("id"));
  if (!parsed.success) {
    console.error("Job retry failed:", "Missing job id");
    return;
  }
  await retryJob(parsed.data);
}
