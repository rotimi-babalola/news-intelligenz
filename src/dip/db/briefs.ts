import type { Prisma } from "../../generated/prisma/client";
import type { Client } from "./client";

export function findProceedingBrief(client: Client, key: string) {
  return client.proceedingBrief.findUnique({ where: { key } });
}

export function saveProceedingBrief(
  client: Client,
  key: string,
  proceedingApiId: string,
  language: string,
  answer: Prisma.InputJsonValue,
) {
  return client.proceedingBrief.upsert({
    where: { key },
    create: { key, proceedingApiId, language, answer },
    update: {},
  });
}
