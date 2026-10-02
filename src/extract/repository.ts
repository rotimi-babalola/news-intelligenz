import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { canonicalArticleUrl } from "../identity";
import { textHash } from "../extract";

type Client = PrismaClient | Prisma.TransactionClient;

export type StoreOutcome =
  | { stored: true; versionNo: number }
  | { stored: false; reason: "unchanged" | string };

export function listVersions(client: Client, publicationId: string) {
  return client.publicationVersion.findMany({
    where: { publicationId },
    orderBy: [{ versionNo: "asc" }],
  });
}

// Restart-safe single-transaction store: identity learned during extraction
// (the redirect-resolved final URL) is reconciled before any write; identical
// text never creates a new version (hash unique per publication).
export async function storeExtractedText(
  client: Client,
  args: {
    publicationId: string;
    publisher: string;
    finalUrl: string;
    text: string;
  },
): Promise<StoreOutcome> {
  const canonicalFinal = canonicalArticleUrl(args.finalUrl);
  if (canonicalFinal) {
    const clash = await client.publicationIdentifier.findUnique({
      where: {
        publisher_kind_value: {
          publisher: args.publisher,
          kind: "url",
          value: canonicalFinal,
        },
      },
      select: { publicationId: true },
    });
    if (clash && clash.publicationId !== args.publicationId) {
      await client.publication.update({
        where: { id: args.publicationId },
        data: {
          extractionError:
            "Final article URL belongs to another publication; kept original link",
        },
      });
      return { stored: false, reason: "final-url-conflict" };
    }
  }
  const hash = textHash(args.text);
  const existing = await client.publicationVersion.findUnique({
    where: {
      publicationId_textHash: {
        publicationId: args.publicationId,
        textHash: hash,
      },
    },
    select: { versionNo: true },
  });
  if (existing) {
    await client.publication.update({
      where: { id: args.publicationId },
      data: { contentAvailability: "full_text", extractionError: null },
    });
    return { stored: false, reason: "unchanged" };
  }
  const latest = await client.publicationVersion.findFirst({
    where: { publicationId: args.publicationId },
    orderBy: [{ versionNo: "desc" }],
    select: { versionNo: true },
  });
  const versionNo = (latest?.versionNo ?? 0) + 1;
  await client.publicationVersion.create({
    data: {
      publicationId: args.publicationId,
      versionNo,
      text: args.text,
      textHash: hash,
      finalUrl: args.finalUrl,
    },
  });
  if (canonicalFinal) {
    await client.publicationIdentifier.upsert({
      where: {
        publisher_kind_value: {
          publisher: args.publisher,
          kind: "url",
          value: canonicalFinal,
        },
      },
      create: {
        publisher: args.publisher,
        kind: "url",
        value: canonicalFinal,
        publicationId: args.publicationId,
      },
      update: {},
    });
  }
  await client.publication.update({
    where: { id: args.publicationId },
    data: { contentAvailability: "full_text", extractionError: null },
  });
  return { stored: true, versionNo };
}

export function recordExtractionFailure(
  client: Client,
  publicationId: string,
  reason: string,
) {
  return client.publication.update({
    where: { id: publicationId },
    data: { extractionError: reason.slice(0, 2000) },
  });
}
