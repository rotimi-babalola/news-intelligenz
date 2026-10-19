import assert from "node:assert/strict";
import { test } from "node:test";
import { retryJob } from "../src/admin/service.js";
import { processNextDocument, requestDocument } from "../src/dip/documents.js";
import { processNextDipEmbedding } from "../src/dip/embedding.js";
import { EMBED_DOCUMENT, ON_DEMAND_PRIORITY } from "../src/dip/jobs.js";
import { collectSteps } from "../src/dip/steps.js";
import { claimNextJob, requeueStaleClaims } from "../src/jobs.js";
import { isolatedDatabase } from "./dip-test-db.js";

const NOW = new Date("2026-10-20T12:00:00+02:00");
const PDF_URL = "https://dserver.bundestag.de/btd/21/010/2110010.pdf";
const HOT = "2026-10-09";

function step(id: string, pdfUrl: string | null = PDF_URL) {
  return {
    id,
    typ: "Vorgangsposition",
    vorgangsposition: "Kleine Anfrage",
    zuordnung: "BT",
    gang: false,
    fortsetzung: false,
    nachtrag: false,
    vorgangstyp: "Kleine Anfrage",
    titel: "Titel 340135",
    dokumentart: "Drucksache",
    vorgang_id: "340135",
    datum: HOT,
    aktualisiert: `${HOT}T13:24:22+02:00`,
    fundstelle: {
      id: "29701499",
      dokumentnummer: "21/1001",
      datum: HOT,
      ...(pdfUrl ? { pdf_url: pdfUrl } : {}),
    },
    aktivitaet_anzahl: 0,
  };
}

function collect(
  prisma: Awaited<ReturnType<typeof isolatedDatabase>>,
  runId: string,
  document = step("701400"),
  now = NOW,
) {
  return collectSteps(prisma, {
    runId,
    electoralTerm: 21,
    now,
    fetchPage: async () => ({
      documents: [document],
      cursor: "x",
      numFound: 1,
    }),
  });
}

const pages = [
  { page: 1, text: "Deutscher Bundestag Drucksache 21/1001" },
  { page: 2, text: "Anlage 1 Haushalt" },
];

test("a document job caches bytes, stores pages and hands off embedding", async () => {
  const prisma = await isolatedDatabase();
  try {
    await collect(prisma, "doc-collect-1");
    const checkpoint = await prisma.dipCheckpoint.findUniqueOrThrow({
      where: {
        endpoint_electoralTerm: {
          endpoint: "/vorgangsposition",
          electoralTerm: 21,
        },
      },
    });
    const bytes = Buffer.from("%PDF-1.7 page text");
    const result = await processNextDocument(prisma, "worker", {
      fetchPdf: async () => ({ ok: true, bytes, finalUrl: PDF_URL }),
      extract: async () => pages,
    });
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.equal(result.variantNo, 1);
    assert.equal(result.reused, false);

    const content = await prisma.documentContent.findFirstOrThrow({
      where: { referenceId: "29701499" },
    });
    assert.equal(content.byteSize, bytes.byteLength);
    assert.equal(content.pageCount, 2);
    assert.equal(content.isLatest, true);
    assert.deepEqual(
      await prisma.documentPage.findMany({
        where: { contentId: content.id },
        orderBy: { pageNo: "asc" },
        select: { pageNo: true, text: true },
      }),
      pages.map((page) => ({ pageNo: page.page, text: page.text })),
    );

    // One durable embedding job per page, through the shared pipeline.
    assert.equal(
      await prisma.processingJob.count({
        where: { operation: EMBED_DOCUMENT, status: "pending" },
      }),
      pages.length,
    );
    const inputs: string[] = [];
    for (let call = 0; call < pages.length; call++)
      assert.equal(
        (
          await processNextDipEmbedding(prisma, "worker", {
            operation: EMBED_DOCUMENT,
            embed: async (text) => {
              inputs.push(text);
              return Array.from({ length: 1024 }, () => 0.1);
            },
          })
        ).status,
        "succeeded",
      );
    assert.deepEqual(
      inputs,
      pages.map((page) => page.text),
    );
    assert.deepEqual(
      await prisma.dipEmbedding.findMany({
        where: { sourceEntity: "dokument" },
        orderBy: { sourcePage: "asc" },
        select: { sourceApiId: true, sourceVersionNo: true, sourcePage: true },
      }),
      pages.map((page) => ({
        sourceApiId: "29701499",
        sourceVersionNo: 1,
        sourcePage: page.page,
      })),
    );

    // Document work never advances or holds the collection checkpoint.
    assert.deepEqual(
      await prisma.dipCheckpoint.findUniqueOrThrow({
        where: {
          endpoint_electoralTerm: {
            endpoint: "/vorgangsposition",
            electoralTerm: 21,
          },
        },
      }),
      checkpoint,
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("identical bytes reuse the cache and changed bytes add a retained variant", async () => {
  const prisma = await isolatedDatabase();
  try {
    const firstBytes = Buffer.from("%PDF variant one");
    let bytes = firstBytes;
    const fetchPdf = async () => ({
      ok: true as const,
      bytes,
      finalUrl: PDF_URL,
    });
    const extract = async () => pages;

    await collect(prisma, "doc-cache-1");
    assert.equal(
      (await processNextDocument(prisma, "worker", { fetchPdf, extract }))
        .status,
      "succeeded",
    );

    // A changed reference (new pdf_url) is new work, but identical bytes are
    // the same content variant: nothing is fetched twice into the cache.
    await collect(prisma, "doc-cache-2", step("701400", `${PDF_URL}?v=2`));
    const reused = await processNextDocument(prisma, "worker", {
      fetchPdf,
      extract,
    });
    assert.equal(reused.status, "succeeded");
    if (reused.status === "succeeded") assert.equal(reused.reused, true);
    assert.equal(await prisma.documentContent.count(), 1);
    const first = await prisma.documentContent.findFirstOrThrow();

    // Changed bytes are a distinct variant; the earlier variant is retained
    // but no longer the searchable one.
    bytes = Buffer.from("%PDF variant two");
    await collect(prisma, "doc-cache-3", step("701400", `${PDF_URL}?v=3`));
    const changed = await processNextDocument(prisma, "worker", {
      fetchPdf,
      extract,
    });
    assert.equal(changed.status, "succeeded");
    if (changed.status === "succeeded") assert.equal(changed.variantNo, 2);
    const contents = await prisma.documentContent.findMany({
      orderBy: { variantNo: "asc" },
    });
    assert.deepEqual(
      contents.map((row) => [row.variantNo, row.isLatest]),
      [
        [1, false],
        [2, true],
      ],
    );
    assert.equal(await prisma.documentPage.count(), 4);
    assert.ok(
      await prisma.documentPage.count({ where: { contentId: first.id } }),
    );

    // Reverting to earlier bytes reuses variant 1 and makes it latest again.
    bytes = firstBytes;
    await collect(prisma, "doc-cache-4", step("701400", `${PDF_URL}?v=4`));
    const reverted = await processNextDocument(prisma, "worker", {
      fetchPdf,
      extract,
    });
    assert.equal(reverted.status, "succeeded");
    if (reverted.status === "succeeded") {
      assert.equal(reverted.variantNo, 1);
      assert.equal(reverted.reused, true);
    }
    assert.deepEqual(
      (
        await prisma.documentContent.findMany({ orderBy: { variantNo: "asc" } })
      ).map((row) => [row.variantNo, row.isLatest]),
      [
        [1, true],
        [2, false],
      ],
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("missing and failed PDFs keep the reference and retry separately", async () => {
  const prisma = await isolatedDatabase();
  try {
    await collect(prisma, "doc-missing", step("701400", null));
    const missing = await processNextDocument(prisma, "worker", {
      fetchPdf: async () => {
        throw new Error("fetch must not run without a url");
      },
    });
    assert.equal(missing.status, "retrying");
    const job = await prisma.processingJob.findFirstOrThrow({
      where: { operation: "process_document" },
    });
    assert.equal(job.lastError, "Document reference has no pdf_url");
    assert.equal(await prisma.documentContent.count(), 0);
    const reference = await prisma.documentReference.findUniqueOrThrow({
      where: { stepApiId: "701400" },
    });
    assert.equal(reference.pdfUrl, null);
    assert.equal(reference.documentNumber, "21/1001");

    // A transient fetch failure backs off and later succeeds on the same job.
    await collect(prisma, "doc-failed", step("701401"));
    assert.equal(
      (
        await processNextDocument(prisma, "worker", {
          fetchPdf: async () => ({ ok: false, reason: "HTTP 503" }),
        })
      ).status,
      "retrying",
    );
    const failed = await prisma.processingJob.findFirstOrThrow({
      where: {
        operation: "process_document",
        payload: { path: ["stepApiId"], equals: "701401" },
      },
    });
    assert.equal(failed.lastError, "Document fetch failed: HTTP 503");
    await prisma.processingJob.update({
      where: { id: failed.id },
      data: { nextAttemptAt: new Date(0) },
    });
    assert.equal(
      (
        await processNextDocument(prisma, "worker", {
          fetchPdf: async () => ({
            ok: true,
            bytes: Buffer.from("%PDF recovered"),
            finalUrl: PDF_URL,
          }),
          extract: async () => pages,
        })
      ).status,
      "succeeded",
    );
  } finally {
    await prisma.$disconnect();
  }
});

test("an on-demand request returns metadata and jumps the queue", async () => {
  const prisma = await isolatedDatabase();
  try {
    // A cold reference: the background hot subset leaves it alone.
    await collect(
      prisma,
      "doc-demand-cold",
      step("701410"),
      new Date("2027-01-01T00:00:00Z"),
    );
    // An older background job that would otherwise be claimed next.
    const background = {
      ...step("701411"),
      fundstelle: {
        ...step("701411").fundstelle,
        id: "29701500",
        pdf_url: "https://dserver.bundestag.de/btd/21/010/2110020.pdf",
      },
    };
    await collect(prisma, "doc-demand-hot", background);
    assert.equal(
      await prisma.processingJob.count({
        where: { operation: "process_document" },
      }),
      1,
    );

    const requested = await requestDocument(prisma, "29701499");
    assert.ok(requested);
    if (!requested) return;
    assert.equal(requested.reference.pdfUrl, PDF_URL);
    assert.equal(requested.reference.documentNumber, "21/1001");
    assert.equal(requested.processed, false);
    assert.equal(requested.job?.priority, ON_DEMAND_PRIORITY);
    assert.equal(requested.job?.status, "pending");

    // Repeating the request converges on the same job instead of adding one.
    await requestDocument(prisma, "29701499");
    assert.equal(
      await prisma.processingJob.count({
        where: { operation: "process_document" },
      }),
      2,
    );

    // The raised job is processed first, ahead of older background work.
    const fetched: string[] = [];
    assert.equal(
      (
        await processNextDocument(prisma, "worker", {
          fetchPdf: async (url) => {
            fetched.push(url);
            return {
              ok: true,
              bytes: Buffer.from("%PDF on demand"),
              finalUrl: url,
            };
          },
          extract: async () => pages,
        })
      ).status,
      "succeeded",
    );
    assert.deepEqual(fetched, [PDF_URL]);
    // The on-demand priority carries into the per-page embedding jobs.
    assert.deepEqual(
      await prisma.processingJob.findMany({
        where: { operation: EMBED_DOCUMENT },
        select: { priority: true },
      }),
      pages.map(() => ({ priority: ON_DEMAND_PRIORITY })),
    );

    const processed = await requestDocument(prisma, "29701499");
    assert.equal(processed?.processed, true);
    assert.equal(processed?.variant?.variantNo, 1);

    // A changed reference is unprocessed again even though an earlier variant
    // of the same document is cached.
    await collect(
      prisma,
      "doc-demand-changed",
      step("701410", `${PDF_URL}?v=2`),
      new Date("2027-01-01T00:00:00Z"),
    );
    const changed = await requestDocument(prisma, "29701499");
    assert.equal(changed?.processed, false);
    assert.equal(changed?.variant, null);
    assert.equal(changed?.job?.status, "pending");
    assert.equal(changed?.job?.priority, ON_DEMAND_PRIORITY);

    assert.equal(await requestDocument(prisma, "999"), null);
  } finally {
    await prisma.$disconnect();
  }
});

test("concurrent variants keep unique numbers and one latest row", async () => {
  const prisma = await isolatedDatabase();
  try {
    await collect(prisma, "doc-race-1", step("701420", `${PDF_URL}?a`));
    await collect(prisma, "doc-race-2", step("701420", `${PDF_URL}?b`));
    const jobs = await prisma.processingJob.findMany({
      where: { operation: "process_document" },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(jobs.length, 2);
    const results = await Promise.all(
      jobs.map((job, index) =>
        processNextDocument(prisma, `worker-${index}`, {
          jobId: job.id,
          fetchPdf: async () => ({
            ok: true,
            bytes: Buffer.from(`%PDF concurrent ${index}`),
            finalUrl: PDF_URL,
          }),
          extract: async () => pages,
        }),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ["succeeded", "succeeded"],
    );
    const contents = await prisma.documentContent.findMany({
      orderBy: { variantNo: "asc" },
    });
    assert.deepEqual(
      contents.map((row) => row.variantNo),
      [1, 2],
    );
    assert.equal(contents.filter((row) => row.isLatest).length, 1);
  } finally {
    await prisma.$disconnect();
  }
});

test("an on-demand request revives an exhausted document job", async () => {
  const prisma = await isolatedDatabase();
  try {
    await collect(prisma, "doc-exhausted");
    const job = await prisma.processingJob.findFirstOrThrow({
      where: { operation: "process_document" },
    });
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: "exhausted",
        attempts: job.maxAttempts,
        lastError: "HTTP 503",
        nextAttemptAt: new Date(0),
      },
    });

    const requested = await requestDocument(prisma, "29701499");
    assert.equal(requested?.job?.status, "pending");
    assert.equal(requested?.job?.priority, ON_DEMAND_PRIORITY);
    const revived = await prisma.processingJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    assert.equal(revived.status, "pending");
    assert.equal(revived.maxAttempts, job.maxAttempts * 2);
    assert.equal(revived.lastError, null);
  } finally {
    await prisma.$disconnect();
  }
});

test("a worker restart resumes the claimed document job", async () => {
  const prisma = await isolatedDatabase();
  try {
    await collect(prisma, "doc-restart");
    const claimed = await claimNextJob(prisma, "dying-worker", undefined, {
      operation: "process_document",
    });
    assert.ok(claimed);
    await prisma.processingJob.update({
      where: { id: claimed.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal((await requeueStaleClaims(prisma)).count, 1);
    assert.equal(
      (
        await processNextDocument(prisma, "new-worker", {
          fetchPdf: async () => ({
            ok: true,
            bytes: Buffer.from("%PDF after restart"),
            finalUrl: PDF_URL,
          }),
          extract: async () => pages,
        })
      ).status,
      "succeeded",
    );
    assert.equal(await prisma.documentContent.count(), 1);
  } finally {
    await prisma.$disconnect();
  }
});

test("admin retry reprocesses an exhausted document job", async () => {
  const prisma = await isolatedDatabase();
  try {
    await collect(
      prisma,
      "doc-admin-retry",
      step("701402", "http://127.0.0.1:1/doc.pdf"),
    );
    const job = await prisma.processingJob.findFirstOrThrow({
      where: { operation: "process_document" },
    });
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: "exhausted",
        attempts: job.maxAttempts,
        lastError: "HTTP 503",
        nextAttemptAt: new Date(0),
      },
    });
    await retryJob(job.id);
    const retried = await prisma.processingJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    assert.equal(retried.attempts, job.maxAttempts + 1);
    assert.equal(retried.maxAttempts, job.maxAttempts * 2);
    assert.equal(
      retried.lastError,
      "Document fetch failed: Blocked private/local destination",
    );
  } finally {
    await prisma.$disconnect();
  }
});
