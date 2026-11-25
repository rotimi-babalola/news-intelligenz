import type { BriefLanguage } from "../dip/explain/types";

// Common function words, not content words: they identify the language of a
// question without needing a model. Words both languages share sit in both
// sets and cancel out; a tie falls back to English, the product's default.
const GERMAN_WORDS = new Set(
  "der die das den dem des ein eine einer eines und oder aber ist sind war waren wird werden wurde wurden hat haben hatte hatten nicht kein keine sich auf für mit von zu zur zum im in am an bei aus nach über unter vor durch als dass ob wie was wer wann warum welche welcher welches soll sollen muss müssen kann können darf dürfen es".split(
    " ",
  ),
);
const ENGLISH_WORDS = new Set(
  "the a an and or but is are was were will would has have had not no this that these those of to in on at by for with from about as which what who when why how should must can could does do did was".split(
    " ",
  ),
);

export function inferLanguage(
  question: string,
  override?: BriefLanguage,
): BriefLanguage {
  if (override) return override;
  const tokens = question
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  let german = /[äöüß]/i.test(question) ? 1 : 0;
  let english = 0;
  for (const token of tokens) {
    if (GERMAN_WORDS.has(token)) german++;
    if (ENGLISH_WORDS.has(token)) english++;
  }
  return german > english ? "de" : "en";
}
