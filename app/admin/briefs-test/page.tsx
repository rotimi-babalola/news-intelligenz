import { database } from "../../../src/db";
import { listRecentProceedings } from "../../../src/dip/repository";
import { BriefTester } from "./tester";

export const dynamic = "force-dynamic";

export default async function BriefTestPage() {
  const prisma = database();
  try {
    return <BriefTester proceedings={await listRecentProceedings(prisma)} />;
  } finally {
    await prisma.$disconnect();
  }
}
