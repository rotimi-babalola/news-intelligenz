import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const schema = new URL(url).searchParams.get("schema") ?? undefined;
  const adapter = new PrismaPg(
    { connectionString: url },
    schema ? { schema } : undefined,
  );
  return new PrismaClient({ adapter });
}
