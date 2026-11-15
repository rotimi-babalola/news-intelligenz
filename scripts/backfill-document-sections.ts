import { database } from "../src/db.js";
import { backfillDocumentSections } from "../src/dip/documents/sections.js";

// One-off backfill for variants stored before section outlines existed.
// Re-running is safe: variants that already have an outline are left untouched.
const prisma = database();
try {
  const result = await backfillDocumentSections(prisma);
  console.log(`variants=${result.variants} outlines=${result.outlines}`);
} finally {
  await prisma.$disconnect();
}
