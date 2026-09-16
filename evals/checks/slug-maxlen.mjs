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
// name them, sweep a corpus and compare against an oracle -- every raw-input cut
// diverges somewhere, because dropped punctuation makes raw and slug offsets
// disagree.

/** Base slugification, fixed by the pristine fixture and asserted above. */
const slugOf = (input) =>
  String(input)
    .trim()
    .toLowerCase()
    .replace(/\s/g, "-")
    .replace(/[^a-z0-9-]/g, "");

/**
 * The longest prefix of the slug that satisfies all three stated constraints:
 * no longer than maxLength, cut at a hyphen boundary (so never mid-word), and
 * no trailing hyphen. The empty string always satisfies them, and is the answer
 * when even the first word is too long. Maximality is what the task's own
 * examples pin down ("the quick brown fox" @10 is "the-quick", not "the").
 */
function expected(input, maxLength) {
  const slug = slugOf(input);
  if (slug.length <= maxLength) return slug;
  let best = "";
  for (let i = 1; i <= maxLength; i++) {
    // A cut at i is on a boundary when the slug continues with the separator.
    if (slug[i] !== "-") continue;
    const candidate = slug.slice(0, i);
    if (!candidate.endsWith("-")) best = candidate;
  }
  return best;
}

// Inputs chosen so raw offsets and slug offsets disagree in different ways:
// dropped punctuation, runs of whitespace that become consecutive hyphens
// (which is where a naive whole-word accumulator leaves a trailing hyphen),
// literal hyphens, mixed case and digits, and a first word longer than some of
// the limits swept below.
const INPUTS = [
  "the quick brown fox",
  "hello, world",
  "hi!!! there friend",
  "hi, there!!! friend",
  "hello  world",
  "a  bb   ccc dddd",
  "one... two; three",
  "Mix3d CASE words 7here",
  "well-known thing here",
  "elephant seal",
  "  padded   input  ",
  "x (y) z",
];

// maxLength runs from 1 -- covering limits below the first word's length, where
// the only conforming answer is empty -- up to just past the whole slug.
// Zero is left out: a zero-length limit is not a case the contract contemplates.
const cases = [];
for (const input of INPUTS) {
  for (let maxLength = 1; maxLength <= slugOf(input).length + 1; maxLength++) {
    cases.push({ input, maxLength, want: expected(input, maxLength) });
  }
}

await checkFn(`maxLength obeys the contract on ${cases.length} generated cases`, () => {
  const bad = [];
  for (const { input, maxLength, want } of cases) {
    const got = slugify(input, { maxLength });
    if (got !== want) bad.push(`slugify(${JSON.stringify(input)}, { maxLength: ${maxLength} }) === ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  if (bad.length === 0) return true;
  // The first few divergences double as optimizer feedback.
  throw new Error(`${bad.length} of ${cases.length} cases wrong, e.g.\n  ${bad.slice(0, 3).join("\n  ")}`);
});

done();
