# Citing a document section

The section outline returned by `get_document_pages` is a navigation hint. Before attributing a passage to one of its sections, call `verify_document_section` with the reference ID and the section's one-based number. Use the section label and title only when the result is `verified`; inspect its exact heading anchor, stored-page context, PDF line positions, and next heading or document-end boundary.

Confirm the proposed quote appears on a stored page within the returned inclusive range, then cite that page and the source PDF URL. The verification tool does not check quotes. If verification returns `ambiguous`, `unavailable`, or `metadata-only`, cite page evidence without a section claim when eligible page evidence exists, or abstain. Do not use extracted text for a metadata-only reference.
