import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client";

const LIMIT = 60;
const WINDOW_MS = 60_000;

function verifier(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueInvite(prisma: PrismaClient, label: string) {
  if (!label.trim() || label.length > 100)
    throw new Error("Label must contain 1–100 characters");
  const token = randomBytes(32).toString("base64url");
  const record = await prisma.mcpInviteToken.create({
    data: { label: label.trim(), verifier: verifier(token) },
  });
  return { id: record.id, token };
}

export async function revokeInvite(prisma: PrismaClient, id: string) {
  const result = await prisma.mcpInviteToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count === 1;
}

export async function authorizeMcpRequest(
  prisma: PrismaClient,
  authorization: string | undefined,
  now = new Date(),
): Promise<401 | 429 | null> {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  if (!match) return 401;
  const token = await prisma.mcpInviteToken.findUnique({
    where: { verifier: verifier(match[1]!) },
    select: { id: true, revokedAt: true },
  });
  if (!token || token.revokedAt) return 401;

  const cutoff = new Date(now.getTime() - WINDOW_MS);
  await prisma.mcpInviteToken.updateMany({
    where: { id: token.id, revokedAt: null, windowStartedAt: { lte: cutoff } },
    data: { windowStartedAt: now, requestsInWindow: 0 },
  });
  const admitted = await prisma.mcpInviteToken.updateMany({
    where: { id: token.id, revokedAt: null, requestsInWindow: { lt: LIMIT } },
    data: { requestsInWindow: { increment: 1 } },
  });
  if (admitted.count) return null;
  const active = await prisma.mcpInviteToken.findUnique({
    where: { id: token.id },
    select: { revokedAt: true },
  });
  return active?.revokedAt ? 401 : 429;
}
