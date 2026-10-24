---
status: accepted
---

# Share DIP evidence with agents through a read-only MCP server

Offer one hosted, HTTPS MCP server over the shared DIP corpus so invited people can use it from Codex, OpenCode, Claude Code, and Claude chat without running their own collector. The first tools search current DIP evidence, inspect a proceeding and its ordered steps, and read bounded excerpts from processed document pages. Return source links, record versions, page numbers, and the attribution required by the [DIP terms](https://dip.bundestag.de/documents/nutzungsbedingungen_dip.pdf); agents compose English explanations and must cite the evidence. An unavailable page is reported as unavailable, not silently fetched or queued. Historical comparison, collection controls, job retries, and answer generation are outside this server's first scope.

Start with individual, revocable read-only tokens for an invited pilot. This avoids operating an OAuth sign-in flow before there is evidence that people use the server; revisit managed sign-in if distributing tokens becomes burdensome. Expose page text only for documents confirmed to be covered Bundestag or Bundesrat works, with document type and number when required. Other references return metadata and the original link until their rights are checked, because the DIP terms do not rule out third-party rights. The hosting provider and monthly budget remain open until deployment. Judge the pilot by whether each client can answer a real question about a stored proceeding with the correct timeline and a traceable document-page citation.
