import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { isolatedDatabase } from "./dip-test-db.js";
import {
  authorizeMcpRequest,
  issueInvite,
  revokeInvite,
} from "../src/mcp/auth.js";

test("MCP invites are individually revocable and limited to 60 requests per minute", async () => {
  const prisma = await isolatedDatabase();
  try {
    const first = await issueInvite(prisma, "First reader");
    const second = await issueInvite(prisma, "Second reader");
    const stored = await prisma.mcpInviteToken.findUniqueOrThrow({
      where: { id: first.id },
    });
    assert.equal(stored.label, "First reader");
    assert.notEqual(stored.verifier, first.token);
    assert.equal(JSON.stringify(stored).includes(first.token), false);
    assert.equal(await authorizeMcpRequest(prisma, undefined), 401);
    assert.equal(
      await authorizeMcpRequest(prisma, `Bearer ${"a".repeat(43)}`),
      401,
    );
    const now = new Date();
    for (let i = 0; i < 60; i++) {
      assert.equal(
        await authorizeMcpRequest(prisma, `Bearer ${first.token}`, now),
        null,
      );
    }
    assert.equal(
      await authorizeMcpRequest(prisma, `Bearer ${first.token}`, now),
      429,
    );
    assert.equal(
      await authorizeMcpRequest(prisma, `Bearer ${second.token}`, now),
      null,
    );
    assert.equal(
      await authorizeMcpRequest(
        prisma,
        `Bearer ${first.token}`,
        new Date(now.getTime() + 60_001),
      ),
      null,
    );
    assert.equal(await revokeInvite(prisma, first.id), true);
    assert.equal(await revokeInvite(prisma, first.id), false);
    assert.equal(
      await authorizeMcpRequest(prisma, `Bearer ${first.token}`),
      401,
    );
    assert.equal(
      await authorizeMcpRequest(prisma, `Bearer ${second.token}`),
      null,
    );
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const address = probe.address();
        assert.ok(address && typeof address !== "string");
        probe.close(() => resolve(address.port));
      });
    });
    const server = spawn(process.execPath, ["dist/scripts/run-mcp.js"], {
      env: { ...process.env, MCP_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    server.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    server.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("MCP startup timed out")),
          10_000,
        );
        server.stderr.on("data", (chunk) => {
          if (String(chunk).includes("MCP listening")) {
            clearTimeout(timeout);
            resolve();
          }
        });
        server.on("exit", () => reject(new Error("MCP exited before startup")));
      });
      const secretBody = "request-secret-should-not-appear";
      const request = (authorization?: string, name?: string) =>
        fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
            ...(authorization ? { authorization } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: name ? "tools/call" : "tools/list",
            params: name ? { name, arguments: {} } : { marker: secretBody },
          }),
        });
      assert.equal((await request()).status, 401);
      const invalid = await request(`Bearer ${"a".repeat(43)}`);
      assert.equal(invalid.status, 401);
      assert.equal((await invalid.text()).includes(secretBody), false);
      const valid = await request(`Bearer ${second.token}`);
      assert.equal(valid.status, 200);
      const body = await valid.text();
      for (const name of [
        "get_proceeding",
        "get_document_pages",
        "search_dip_evidence",
      ])
        assert.ok(body.includes(name));
      assert.equal(body.includes("mcp:invites"), false);
      const rejected = await request(`Bearer ${second.token}`, secretBody);
      assert.equal(rejected.status, 200);
      assert.equal((await rejected.text()).includes(secretBody), false);
      assert.equal((await request(`Bearer ${first.token}`)).status, 401);
      assert.equal(output.includes(first.token), false);
      assert.equal(output.includes(second.token), false);
      assert.equal(output.includes(secretBody), false);
    } finally {
      server.kill("SIGTERM");
    }
  } finally {
    await prisma.$disconnect();
  }
});
