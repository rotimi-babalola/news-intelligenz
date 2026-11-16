import type { Prisma, PrismaClient } from "./generated/prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

// Collection runs shared by news intake, DIP collection and reindexes.
export function findRun(client: Client, runId: string) {
  return client.run.findUnique({ where: { id: runId } });
}

export function findRunOrThrow(client: Client, runId: string) {
  return client.run.findUniqueOrThrow({ where: { id: runId } });
}

export function createRun(
  client: Client,
  data: Prisma.RunUncheckedCreateInput,
) {
  return client.run.create({ data });
}

export function finalizeRun(
  client: Client,
  runId: string,
  data: Prisma.RunUncheckedUpdateInput,
) {
  return client.run.update({ where: { id: runId }, data });
}

// Insert a run only when absent; an existing row is left untouched.
export function ensureRun(
  client: Client,
  data: Prisma.RunUncheckedCreateInput,
) {
  return client.run.upsert({
    where: { id: data.id },
    update: {},
    create: data,
  });
}
