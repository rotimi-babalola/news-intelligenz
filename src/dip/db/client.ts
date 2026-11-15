import type { Prisma, PrismaClient } from "../../generated/prisma/client";

export type Client = PrismaClient | Prisma.TransactionClient;
