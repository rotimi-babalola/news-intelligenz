import { database } from "../src/db.js";
import { issueInvite, revokeInvite } from "../src/mcp/auth.js";

const [action, value, ...extra] = process.argv.slice(2);
if (extra.length || !value || !["issue", "revoke"].includes(action ?? "")) {
  console.error("Usage: mcp-invites issue <label> | revoke <id>");
  process.exitCode = 1;
} else {
  const prisma = database();
  try {
    if (action === "issue") {
      const invite = await issueInvite(prisma, value);
      console.log(`ID: ${invite.id}\nToken (shown once): ${invite.token}`);
    } else {
      if (!(await revokeInvite(prisma, value)))
        throw new Error("Active invite not found");
      console.log("Invite revoked");
    }
  } catch {
    console.error("Invite operation failed");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
