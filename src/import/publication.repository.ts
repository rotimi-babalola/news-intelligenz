import type { Prisma, PrismaClient } from "../generated/prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

export type IdentityKey = { kind: "url" | "guid"; value: string };

export function findPublicationIdsByKeys(
  client: Client,
  publisher: string,
  keys: IdentityKey[],
) {
  return client.publicationIdentifier.findMany({
    where: { publisher, OR: keys },
    select: { publicationId: true },
  });
}

export function upsertPublication(
  client: Client,
  create: Prisma.PublicationUncheckedCreateInput,
  update: Prisma.PublicationUncheckedUpdateInput,
) {
  return client.publication.upsert({
    where: { id: create.id },
    create,
    update,
  });
}

export function upsertIdentifier(
  client: Client,
  data: { publisher: string; kind: "url" | "guid"; value: string },
  publicationId: string,
) {
  return client.publicationIdentifier.upsert({
    where: {
      publisher_kind_value: {
        publisher: data.publisher,
        kind: data.kind,
        value: data.value,
      },
    },
    create: { ...data, publicationId },
    update: {},
  });
}
