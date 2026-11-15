import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import pg from "pg";
import {
  collectIntake,
  drainJobs,
  drainOpenJobs,
  finalizeRunIfSettled,
  processJob,
} from "../src/import/service.js";
import {
  claimNextJob,
  completeJob,
  dipSource,
  enqueueJob,
  failJob,
  listJobs,
  requeueStaleClaims,
  retryExhausted,
  runJobs,
  searchSource,
} from "../src/jobs/index.js";
import type { Feed } from "../src/sources.js";

const root = process.cwd();

const feed: Feed = {
  id: "jobs-test-feed",
  publisher: "Jobs Test Publisher",
  url: "https://example.org/jobs.rss",
  defaultLanguage: "de",
};

const item = (id: string) =>
  `<item><title>Job headline ${id}</title>` +
  `<link>https://example.org/job-${id}.html</link>` +
  `<guid>job-${id}</guid>` +
  `<pubDate>Tue, 22 Sep 2026 08:00:00 +0200</pubDate></item>`;

const xml = (ids: string[]) =>
  `<rss><channel><language>de</language>${ids.map(item).join("")}</channel></rss>`;

async function isolatedDb() {
  const baseUrl = process.env.DATABASE_URL!;
  const directUrl = process.env.DATABASE_URL_UNPOOLED || baseUrl;
  const admin = new pg.Pool({ connectionString: baseUrl });
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  const schemaUrl = url.toString();
  // Neon's pooler cannot run schema migrations; the CLI uses the direct host.
  const direct = new URL(directUrl);
  direct.searchParams.set("schema", schema);
  process.env.DATABASE_URL = schemaUrl;
  process.env.DATABASE_URL_UNPOOLED = direct.toString();
  await promisify(execFile)("node_modules/.bin/prisma", ["migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: schemaUrl },
    cwd: root,
  });
  const { database } = await import("../src/db.js");
  return {
    prisma: database(),
    done: async () => {
      process.env.DATABASE_URL = baseUrl;
      process.env.DATABASE_URL_UNPOOLED = directUrl;
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test("interrupted workers resume without duplicating committed work", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    // Crash between handoff and processing: intake commits, nothing downstream.
    const intake = await collectIntake(
      prisma,
      "interrupted",
      xml(["a", "b"]),
      feed,
    );
    assert.equal(intake.settled, false);
    assert.equal(await prisma.publication.count(), 0);
    assert.equal(await prisma.discovery.count(), 0);
    assert.equal(await prisma.candidate.count(), 2);
    assert.equal(
      await prisma.processingJob.count({ where: { status: "pending" } }),
      2,
    );
    let run = await prisma.run.findUniqueOrThrow({
      where: { id: "interrupted" },
    });
    assert.equal(run.status, "running");

    // A restarted worker drains the same durable handoff and settles the run.
    await drainJobs(prisma, "restarted-worker", { runId: "interrupted" });
    run = await finalizeRunIfSettled(prisma, "interrupted", intake.parseError);
    assert.equal(run.status, "completed");
    assert.equal(run.validCount, 2);
    assert.equal(await prisma.publication.count(), 2);
    assert.equal(await prisma.discovery.count(), 2);

    // Redelivering an already-committed job never duplicates records.
    const jobs = await prisma.processingJob.findMany({
      where: { runId: "interrupted" },
    });
    for (const stored of jobs) {
      await processJob(prisma, {
        id: stored.id,
        dedupeKey: stored.dedupeKey,
        sourceKind: stored.sourceKind,
        sourceKey: stored.sourceKey,
        sourceScope: stored.sourceScope,
        runId: stored.runId,
        itemIndex: stored.itemIndex,
        operation: stored.operation,
        payload: stored.payload,
        attempts: stored.attempts,
        maxAttempts: stored.maxAttempts,
        priority: stored.priority,
      });
    }
    assert.equal(await prisma.publication.count(), 2);
    assert.equal(await prisma.discovery.count(), 2);
    assert.equal(await prisma.candidate.count(), 2);
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("concurrent claims hand each job to exactly one worker", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    await collectIntake(prisma, "race", xml(["x"]), feed);
    const [first, second] = await Promise.all([
      claimNextJob(prisma, "worker-a", undefined, { runId: "race" }),
      claimNextJob(prisma, "worker-b", undefined, { runId: "race" }),
    ]);
    assert.ok((first === null) !== (second === null));
    const winner = first ?? second!;
    const loser = first === null ? "worker-a" : "worker-b";
    assert.equal(
      await prisma.jobAttempt.count({ where: { jobId: winner.id } }),
      1,
    );
    // The loser finds nothing left to claim for this run.
    assert.equal(
      await claimNextJob(prisma, loser, undefined, { runId: "race" }),
      null,
    );
    await processJob(prisma, winner);
    await completeJob(
      prisma,
      winner,
      winner.id === first?.id ? "worker-a" : "worker-b",
    );
    assert.equal(
      await prisma.processingJob
        .findUniqueOrThrow({ where: { id: winner.id } })
        .then((job) => job.status),
      "succeeded",
    );
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("the runner settles succeeded, retrying and exhausted through one union", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    await prisma.run.create({
      data: {
        id: "runner",
        feedId: "runner",
        sourceKind: "news_feed",
        inputHash: "h",
        status: "running",
      },
    });
    const enqueue = (dedupeKey: string, payload: object, maxAttempts = 5) =>
      prisma.processingJob.create({
        data: {
          dedupeKey,
          sourceKind: "news_feed",
          sourceKey: "runner",
          runId: "runner",
          operation: "runner-test",
          payload,
          maxAttempts,
        },
      });
    const ok = await enqueue("runner-ok", {});
    const retrying = await enqueue("runner-retrying", { fail: true }, 2);
    const exhausted = await enqueue("runner-exhausted", { fail: true }, 1);
    const outcomes = await runJobs(
      prisma,
      "runner-worker",
      { runId: "runner" },
      async (job) => {
        if ((job.payload as { fail?: boolean }).fail)
          throw new Error("handler failed");
        return { handled: job.id };
      },
    );
    const settled = new Map(
      outcomes.map((outcome) => [outcome.jobId, outcome]),
    );
    assert.equal(outcomes.length, 3);
    const success = settled.get(ok.id);
    assert.equal(success?.status, "succeeded");
    if (success?.status === "succeeded") assert.equal(success.handled, ok.id);
    assert.equal(settled.get(retrying.id)?.status, "retrying");
    assert.equal(settled.get(exhausted.id)?.status, "exhausted");
    assert.equal(
      (
        await prisma.processingJob.findUniqueOrThrow({
          where: { id: retrying.id },
        })
      ).lastError,
      "handler failed",
    );
    assert.equal(
      (
        await prisma.processingJob.findUniqueOrThrow({
          where: { id: exhausted.id },
        })
      ).attempts,
      1,
    );
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("the runner reports a stale outcome when its claim is taken over", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    await prisma.run.create({
      data: {
        id: "stale-run",
        feedId: "stale-run",
        sourceKind: "news_feed",
        inputHash: "h",
        status: "running",
      },
    });
    const job = await prisma.processingJob.create({
      data: {
        dedupeKey: "runner-stale",
        sourceKind: "news_feed",
        sourceKey: "stale-run",
        runId: "stale-run",
        operation: "runner-test",
        payload: {},
      },
    });
    const outcomes = await runJobs(
      prisma,
      "worker-a",
      { runId: "stale-run" },
      async (claimed) => {
        // Another worker takes the job over while this attempt is running.
        await prisma.processingJob.update({
          where: { id: claimed.id },
          data: { leaseExpiresAt: new Date(0) },
        });
        assert.ok(
          await claimNextJob(prisma, "worker-b", undefined, {
            jobId: claimed.id,
          }),
        );
      },
    );
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.status, outcome.jobId]),
      [["stale", job.id]],
    );
    assert.equal(
      (
        await prisma.processingJob.findUniqueOrThrow({
          where: { id: job.id },
        })
      ).status,
      "claimed",
    );
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("a reclaimed attempt cannot overwrite its successor", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    await collectIntake(prisma, "handoff", xml(["h"]), feed);
    const first = await claimNextJob(prisma, "worker-a", undefined, {
      runId: "handoff",
    });
    assert.ok(first);
    await prisma.processingJob.update({
      where: { id: first.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    const second = await claimNextJob(prisma, "worker-b", undefined, {
      jobId: first.id,
    });
    assert.equal(second?.attempts, 2);
    assert.equal(await completeJob(prisma, first, "worker-a"), false);
    assert.deepEqual(
      (await failJob(prisma, first, "worker-a", new Error("late failure")))
        .stale,
      true,
    );
    assert.equal(
      (
        await prisma.processingJob.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).status,
      "claimed",
    );
    assert.equal(await completeJob(prisma, second!, "worker-b"), true);
    assert.equal(
      (
        await prisma.processingJob.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).status,
      "succeeded",
    );
    const attempts = await prisma.jobAttempt.findMany({
      where: { jobId: first.id },
      orderBy: { attemptNo: "asc" },
    });
    assert.deepEqual(
      attempts.map((attempt) => attempt.outcome),
      ["abandoned", "succeeded"],
    );
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("an expired final attempt exhausts instead of exceeding its budget", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    await collectIntake(prisma, "crash-budget", xml(["b"]), feed);
    const first = await claimNextJob(prisma, "worker-a", undefined, {
      runId: "crash-budget",
    });
    assert.ok(first);
    await prisma.processingJob.update({
      where: { id: first.id },
      data: { maxAttempts: 1, leaseExpiresAt: new Date(0) },
    });
    assert.equal(
      await claimNextJob(prisma, "worker-b", undefined, { jobId: first.id }),
      null,
    );
    const job = await prisma.processingJob.findUniqueOrThrow({
      where: { id: first.id },
    });
    assert.equal(job.status, "exhausted");
    assert.equal(job.attempts, 1);
    assert.equal(
      (
        await prisma.jobAttempt.findUniqueOrThrow({
          where: { jobId_attemptNo: { jobId: first.id, attemptNo: 1 } },
        })
      ).outcome,
      "exhausted",
    );
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("expired leases are reclaimed and failures exhaust with visible state", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    await collectIntake(prisma, "leases", xml(["l"]), feed);
    // Worker dies mid-processing holding a short lease.
    const claimed = await claimNextJob(prisma, "dying-worker", 50, {
      runId: "leases",
    });
    assert.ok(claimed);
    assert.equal(
      await prisma.processingJob
        .findUniqueOrThrow({ where: { id: claimed!.id } })
        .then((job) => job.status),
      "claimed",
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const requeued = await requeueStaleClaims(prisma);
    assert.equal(requeued.count, 1);
    const outcome = await drainJobs(prisma, "recovery-worker", {
      runId: "leases",
    });
    // Resolve plus its follow-up text extraction (example.org is outside the
    // permitted full-text hosts, so extraction records metadata-only fallback).
    assert.deepEqual(outcome, { succeeded: 2, retrying: 0, exhausted: 0 });
    assert.equal(await prisma.publication.count(), 1);

    // A deterministically failing job exhausts within its attempt budget
    // while an independent job from another source still succeeds.
    await collectIntake(prisma, "mixed", xml(["m"]), feed);
    const jobs = await prisma.processingJob.findMany({
      where: { runId: "mixed" },
    });
    await prisma.processingJob.update({
      where: { id: jobs[0]!.id },
      data: { operation: "bogus-operation", maxAttempts: 1 },
    });
    await prisma.$transaction((tx) =>
      enqueueJob(tx, {
        source: searchSource("Wohnen", ["example.org"]),
        runId: "mixed",
        itemIndex: 99,
        operation: "bogus-operation",
        payload: {},
        maxAttempts: 1,
      }),
    );
    const mixed = await drainJobs(prisma, "mixed-worker", { runId: "mixed" });
    assert.equal(mixed.exhausted, 2);
    const exhausted = await prisma.processingJob.findMany({
      where: { runId: "mixed", status: "exhausted" },
    });
    assert.equal(exhausted.length, 2);
    assert.match(exhausted[0]!.lastError ?? "", /bogus-operation/);
    assert.equal(
      (await listJobs(prisma, "exhausted")).some(
        (job) => job.runId === "mixed",
      ),
      true,
    );
    // Deliberate operator retry resets the budget for another attempt.
    const retried = await retryExhausted(prisma, exhausted[0]!.id);
    assert.equal(retried.status, "pending");
    assert.equal(retried.attempts, 1);
    assert.equal(retried.maxAttempts, 2);
    const secondClaim = await claimNextJob(prisma, "retry-worker", undefined, {
      jobId: retried.id,
    });
    assert.equal(secondClaim?.attempts, 2);
    assert.equal(
      await prisma.jobAttempt.count({ where: { jobId: retried.id } }),
      2,
    );
    await failJob(
      prisma,
      secondClaim!,
      "retry-worker",
      new Error("still bogus"),
    );

    // Non-RSS source identities survive the round trip on job rows.
    await prisma.$transaction((tx) =>
      enqueueJob(tx, {
        source: dipSource("/vorgang", "21"),
        runId: "mixed",
        itemIndex: 100,
        operation: "bogus-operation",
        payload: { cursor: "abc" },
        maxAttempts: 1,
      }),
    );
    const dip = await prisma.processingJob.findFirstOrThrow({
      where: { runId: "mixed", itemIndex: 100 },
    });
    assert.equal(dip.sourceKind, "dip_endpoint");
    assert.equal(dip.sourceKey, "/vorgang");
    assert.deepEqual(dip.sourceScope, { electoralTerm: "21" });
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("rate-limited failures resume after the provider delay", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    await collectIntake(prisma, "limited", xml(["r"]), feed);
    const claimed = await claimNextJob(prisma, "limited-worker", undefined, {
      runId: "limited",
    });
    assert.ok(claimed);
    const before = Date.now();
    const { exhausted, nextAttemptAt } = await failJob(
      prisma,
      claimed!,
      "limited-worker",
      new Error("Feed rate limited: HTTP 429"),
      { retryAfterMs: 60_000 },
    );
    assert.equal(exhausted, false);
    assert.ok(nextAttemptAt!.getTime() - before >= 59_000);
    const stored = await prisma.processingJob.findUniqueOrThrow({
      where: { id: claimed!.id },
    });
    assert.equal(stored.status, "retrying");
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("the admin service exposes exhausted jobs and retries them deliberately", async () => {
  const { prisma, done } = await isolatedDb();
  const { getNewsOverview, retryJob } = await import("../src/admin/service.js");
  try {
    await collectIntake(prisma, "admin-retry", xml(["op"]), feed);
    const job = await prisma.processingJob.findFirstOrThrow({
      where: { runId: "admin-retry" },
    });
    await prisma.processingJob.update({
      where: { id: job.id },
      data: { status: "exhausted", attempts: 5, lastError: "operator case" },
    });
    const overview = await getNewsOverview("admin-retry");
    assert.equal(overview.counts.exhausted, 1);
    assert.ok(
      overview.attention.some(
        (entry) => entry.id === job.id && entry.status === "exhausted",
      ),
    );
    await retryJob(job.id);
    assert.equal(
      (
        await prisma.processingJob.findUniqueOrThrow({
          where: { id: job.id },
        })
      ).status,
      "succeeded",
    );
    assert.equal(await prisma.publication.count(), 1);
    assert.equal(
      (
        await prisma.run.findUniqueOrThrow({
          where: { id: "admin-retry" },
        })
      ).status,
      "completed",
    );
    // Unknown ids fail soft: the retry resolves without throwing.
    await retryJob(randomUUID());
  } finally {
    await prisma.$disconnect();
    await done();
  }
});

test("drainOpenJobs settles intake without a new collection", async () => {
  const { prisma, done } = await isolatedDb();
  try {
    // Intake only: nothing downstream has run yet.
    await collectIntake(prisma, "drain-me", xml(["a", "b"]), feed);
    assert.equal(await prisma.publication.count(), 0);
    // example.org is outside the permitted full-text hosts, so extraction
    // records metadata-only fallback without network access.
    const result = await drainOpenJobs(prisma, "drain-worker", "drain-me");
    assert.deepEqual(result.outcome, {
      succeeded: 4,
      retrying: 0,
      exhausted: 0,
    });
    assert.deepEqual(result.settled, ["drain-me"]);
    assert.equal(await prisma.publication.count(), 2);
    assert.equal(
      (
        await prisma.run.findUniqueOrThrow({
          where: { id: "drain-me" },
        })
      ).status,
      "completed",
    );
    // Unknown runs are rejected.
    await assert.rejects(drainOpenJobs(prisma, "drain-worker", "missing"));
  } finally {
    await prisma.$disconnect();
    await done();
  }
});
