import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Neon's pooler cannot run schema migrations; the CLI uses the direct host.
    // The app itself reads the pooled DATABASE_URL in src/db.ts.
    url: process.env.DATABASE_URL_UNPOOLED || env("DATABASE_URL"),
  },
});
