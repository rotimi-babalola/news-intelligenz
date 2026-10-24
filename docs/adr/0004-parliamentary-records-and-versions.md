---
status: accepted
---

# Preserve parliamentary records separately from publications

The DIP amendment replaces Bundestag RSS following the user's source-usage concerns and introduces proceedings and their steps, which describe evolving parliamentary matters rather than articles. Keep these records separate from publications, identify them by DIP entity type and ID, and preserve their observed changed states instead of overwriting them or treating each update as a new publication. This retains evidence for future explainers and distinguishes corrections from parliamentary developments, at the cost of separate record views and version handling; linked PDF text is processed lazily. [ADR 0007](0007-dip-only-parliamentary-collection.md) later removes editorial news collection from the target architecture; the separation remains relevant while historical news data is retained.
