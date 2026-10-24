import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// PDF variants are archived in object storage; PostgreSQL keeps only their
// identity and key. Keys are content-addressed, so retries and concurrent
// workers overwrite the same object instead of accumulating duplicates.
export function documentObjectKey(referenceId: string, byteHash: string) {
  return `documents/${referenceId}/${byteHash}.pdf`;
}

let client: S3Client | undefined;

function r2(): S3Client {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey)
    throw new Error("R2 storage is not configured");
  client ??= new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    // R2 rejects the SDK's optional checksum headers on some operations.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return client;
}

export async function putDocumentPdf(key: string, bytes: Buffer) {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error("R2_BUCKET is not configured");
  await r2().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: "application/pdf",
    }),
  );
}
