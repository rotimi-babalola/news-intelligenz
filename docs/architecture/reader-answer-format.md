# Reader answer format

Status: accepted shape for the reader chat in [epic #89](https://github.com/rotimi-babalola/news-intelligenz/issues/89). Implementation: [`src/reader/answer.ts`](../../src/reader/answer.ts).

A generated brief is the operator-facing record behind an explainer: it carries internal proceeding IDs, a retrieval score, per-claim source quotes and five claim categories. The reader answer is the same evidence in the order a reader needs it, with none of the operator detail.

## Order

1. **Short answer.** The direct answer drawn from the brief's `matter` and `stage` claims: what the proceeding is about and where it stands. If both are empty and the brief carries a single step claim, that step becomes the short answer rather than being dropped.
2. **Optional context.** The `documents` and `unresolved` claims: what the relevant document says and what remains open.
3. **Optional timeline.** The ordered `steps` claims, in the order the brief already established.
4. **Inline citations.** Every claim carries one citation label and the link to its proceeding step or document page.
5. **Limitation state.** The brief's qualification, or a limitation-only answer when the brief abstained.

An empty claim category is absent from the view model. The mapper never renders a heading with no claims under it, and it never drops the only supported claim.

## View model

```ts
type ReaderClaim = {
  text: string;
  citation: { label: string; url: string };
};

type ReaderAnswer = {
  language: "en" | "de";
  status: "supported" | "partial" | "abstain";
  shortAnswer?: ReaderClaim[];
  context?: ReaderClaim[];
  timeline?: ReaderClaim[];
  limitation: string | null;
};
```

Mapping rules:

- Claim text is copied from the brief. The mapper never paraphrases, summarises or invents it.
- `shortAnswer`, `context` and `timeline` appear only when they contain claims.
- No internal proceeding, step or document reference ID appears in claim text or citation labels. The citation `url` is a stored source link and may contain the source's own ID; the visible `label` never does.
- No retrieval score, source quote, question, or raw JSON reaches the view model.

`status` follows the brief's answer confidence. `supported` means every claim category was filled and no fact was missing from the evidence. `partial` means the answer is usable but incomplete. `abstain` means no category held a supported claim.

## When the timeline earns its place

The timeline is shown only when the brief carries at least two distinct documented steps. Several claims about one step are context, not a timeline. With one documented step, the step is already the short answer and a timeline adds nothing. A written question with a single question-and-answer pair therefore reads as a short answer plus its document citations, not as a timeline.

The mapper does not derive, sort or extend the timeline. It only decides whether the existing ordered steps are worth showing.

## Citation labels

| Language | Proceeding step     | Document page         |
| -------- | ------------------- | --------------------- |
| English  | `Proceeding step`   | `Document, page {n}`  |
| German   | `Verfahrensschritt` | `Dokument, Seite {n}` |

The label names the kind of source and, for a page, its page number. It never includes the internal reference ID. A page citation without a stored page number is labelled `Document` / `Dokument`. The link beside the label opens the stored step or the cited PDF.

## Limitation and abstention

A limitation statement says plainly what the stored evidence cannot answer. It does not repeat the proceeding title, a date or a retrieval score as if that were an answer.

English:

- Missing facts: `The stored evidence does not contain the requested facts: {facts}.`
- Incomplete answer: `The stored evidence does not establish every part of the answer.`
- Abstention: `The stored evidence does not answer this question.`
- Missing proceeding record: `The proceeding record for this timeline is missing; no explainer can be offered.`

German:

- Missing facts: `Die gespeicherten Belege enthalten die gefragten Angaben nicht: {facts}.`
- Incomplete answer: `Die gespeicherten Belege klären nicht alle Teile der Antwort.`
- Abstention: `Die gespeicherten Belege beantworten diese Frage nicht.`
- Missing proceeding record: `Der Vorgang zu dieser Chronologie fehlt; es kann keine Erläuterung angeboten werden.`

A partial answer keeps its claims and ends with the incomplete-answer limitation. An abstention renders its own sentence alone, with no short answer, context or timeline. When the question asked for a specific fact the evidence does not hold, the limitation names that fact so the reader knows what is missing rather than merely that something is missing.

The brief already produces these sentences for the reader's language. The mapper forwards the qualification unchanged; it does not choose or translate limitation wording itself.
