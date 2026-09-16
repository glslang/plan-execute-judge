import { checkFn, done, fixtureTestsStillPass, importFromWorktree } from "./_util.mjs";

fixtureTestsStillPass("slugger");
const { slugify } = await importFromWorktree("src/slugify.js");

// The contract's own examples, kept by name so a failure reads as the rule it
// broke.
await checkFn('maxLength cuts at a hyphen boundary: "the quick brown fox" @10 -> "the-quick"', () => {
  return slugify("the quick brown fox", { maxLength: 10 }) === "the-quick";
});
await checkFn("exact fit is kept whole", () => {
  return slugify("one two", { maxLength: 7 }) === "one-two";
});
await checkFn("result never ends with a hyphen", () => {
  const out = slugify("alpha beta gamma", { maxLength: 11 });
  return out === "alpha-beta" && !out.endsWith("-");
});
await checkFn("without the option behavior is unchanged", () => {
  return slugify("hello world") === "hello-world";
});

// Cutting the raw input instead of the slug is the failure mode this task
// invites, and it has many shapes: plain truncation, truncation that drops the
// partial word, truncation applied only when the slug is overlong. Rather than
// name them, sweep a corpus where the answer is unambiguous and compare against
// an oracle -- every raw-input cut diverges somewhere in it, because dropped
// punctuation makes raw offsets and slug offsets disagree.
//
// Corpus shape: alphanumeric words joined by separators that contribute exactly
// one space plus punctuation that slugification drops, so the slug is always
// `words.join("-")`. maxLength runs from the first word's length (so some whole
// word always fits, avoiding the case where cutting mid-word or returning empty
// are both defensible) up to the full slug's length.
const WORD_SETS = [
  ["hi", "there", "friend"],
  ["hello", "world"],
  ["the", "quick", "brown", "fox"],
  ["a", "bb", "ccc", "dddd"],
  ["Mix3d", "CASE", "words", "7here"],
];
const SEPARATORS = [" ", ", ", "!!! ", "... ", "; ", " ("];

/** Longest whole-word prefix of the slug that fits in maxLength. */
function expected(words, maxLength) {
  const slug = words.join("-");
  if (slug.length <= maxLength) return slug;
  let out = words[0];
  for (const word of words.slice(1)) {
    const next = `${out}-${word}`;
    if (next.length > maxLength) break;
    out = next;
  }
  return out;
}

const cases = [];
for (const rawWords of WORD_SETS) {
  const words = rawWords.map((w) => w.toLowerCase());
  for (let offset = 0; offset < SEPARATORS.length; offset++) {
    let input = rawWords[0];
    for (let i = 1; i < rawWords.length; i++) {
      input += SEPARATORS[(offset + i) % SEPARATORS.length] + rawWords[i];
    }
    for (let maxLength = words[0].length; maxLength <= words.join("-").length; maxLength++) {
      cases.push({ input, maxLength, want: expected(words, maxLength) });
    }
  }
}

await checkFn(`cut is computed on the slug, not the raw input (${cases.length} cases)`, () => {
  const bad = [];
  for (const { input, maxLength, want } of cases) {
    const got = slugify(input, { maxLength });
    if (got !== want) bad.push(`slugify(${JSON.stringify(input)}, { maxLength: ${maxLength} }) === ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  if (bad.length === 0) return true;
  // Report the first few divergences; the list doubles as optimizer feedback.
  throw new Error(`${bad.length} of ${cases.length} cases wrong, e.g.\n  ${bad.slice(0, 3).join("\n  ")}`);
});

done();
