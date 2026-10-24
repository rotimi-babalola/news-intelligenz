---
status: accepted
---

# Collect parliamentary activity from DIP only

The project will stop collecting editorial news through RSS feeds and search providers and use DIP proceedings, proceeding steps, and linked parliamentary documents as its source material. This narrows the product to parliamentary activity across the institutions represented in the selected DIP electoral terms; future English explainers will be grounded in that evidence. The choice reduces exposure to rights questions around storing news articles while keeping the existing proceeding-centered retrieval design. DIP data is still governed by its [usage terms](https://dip.bundestag.de/documents/nutzungsbedingungen_dip.pdf), including attribution and rules for reproducing documents; public availability alone is not a blanket reuse permission.

This is a target-architecture decision, not a claim that the current runtime has stopped collecting news. Existing news records remain available for internal inspection until a separate cleanup backs them up or exports them, removes the news collectors and interfaces, and applies a reviewed migration to remove news-only tables without harming DIP data or shared jobs. The old RSS and search design and its acceptance criteria are historical. Revisit open tickets that still assume news collection before implementation.
