"use server";

import { retryJob } from "../../src/admin/service";

export async function retryJobAction(formData: FormData) {
  await retryJob(String(formData.get("id") ?? ""));
}
