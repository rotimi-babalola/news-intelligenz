# Implementation plan: shared DIP MCP access

Tasks are native sub-issues of [GitHub epic #46](https://github.com/rotimi-babalola/news-intelligenz/issues/46), not a local checklist. The decision is recorded in [ADR 0008](../docs/adr/0008-shared-read-only-mcp-access.md).

## Scope

Serve the existing DIP corpus to invited users through read-only MCP tools in Codex, OpenCode, Claude Code, and Claude chat. Keep operator and legacy write routes private. Hosting and its budget are selected during deployment.

## Ordered task index

1. [#47 Classify eligible documents](https://github.com/rotimi-babalola/news-intelligenz/issues/47) — gate for page text.
2. [#48 Serve current DIP search](https://github.com/rotimi-babalola/news-intelligenz/issues/48) — first end-to-end MCP slice.
3. [#49 Serve a proceeding timeline](https://github.com/rotimi-babalola/news-intelligenz/issues/49) — reuse the minimum read model from #41.
4. [#50 Serve bounded eligible pages](https://github.com/rotimi-babalola/news-intelligenz/issues/50) — depends on #47 and #48.
5. [#51 Gate access with invite tokens](https://github.com/rotimi-babalola/news-intelligenz/issues/51) — required before remote exposure.
6. [#52 Deploy the isolated MCP endpoint](https://github.com/rotimi-babalola/news-intelligenz/issues/52) — coordinate the DIP runtime with #11.
7. [#53 Verify all four client experiences](https://github.com/rotimi-babalola/news-intelligenz/issues/53) — final acceptance.

## Checkpoints

- After #47–#50: tests and type checks pass; a local MCP client retrieves current search, timeline, and eligible page evidence without data mutation.
- After #51–#52: an external client can use a valid token; revoked or missing tokens and all operator routes are denied.
- After #53: each client answers the same stored-proceeding question with a correct timeline and a traceable page citation.

## Risks and open decision

- DIP-linked PDFs can carry third-party rights; #47 fails closed for unknown documents.
- The current document GET route queues processing; #50 reads stored pages without calling it.
- The existing deployment issue #11 includes superseded news scope; #52 applies ADR 0007 and exposes only MCP to invitees.
- The hosting provider and monthly cost are decided in #52, before deployment.
