import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  let connectionString = url;
  let schema: string | undefined;
  try {
    const parsed = new URL(url);
    schema = parsed.searchParams.get("schema") ?? undefined;
    parsed.searchParams.delete("schema");
    connectionString = parsed.toString();
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  const adapter = new PrismaPg(
    { connectionString },
    schema ? { schema } : undefined,
  );
  // Neon suspends an idle compute; the job that wakes it waits seconds for a
  // connection, past Prisma's 2s maxWait default, and the first transaction
  // fails with P2028 instead of paying the cold start.
  return new PrismaClient({ adapter, transactionOptions: { maxWait: 15_000 } });
}

// Raw SQL needs the same schema selected for Prisma's typed queries.
export function qualifiedTable(table: string): string {
  let schema = "public";
  try {
    schema =
      new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema") ||
      "public";
  } catch {
    // Fall through to the default schema.
  }
  const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return `${ident(schema)}.${ident(table)}`;
}
