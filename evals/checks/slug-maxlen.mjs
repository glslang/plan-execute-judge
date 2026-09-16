import { checkFn, done, fixtureTestsStillPass, importFromWorktree } from "./_util.mjs";

fixtureTestsStillPass("slugger");
const { slugify } = await importFromWorktree("src/slugify.js");

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
// The raw input and its slug diverge before maxLength here ("hello, world"
// truncated to 10 raw chars is "hello, wor" -> "hello-wor"), so truncating the
// input before slugifying cuts mid-word and fails this.
await checkFn('cut is computed on the slug, not the raw input: "hello, world" @10 -> "hello"', () => {
  return slugify("hello, world", { maxLength: 10 }) === "hello";
});
// Stronger still: the normalized slug "hi-there" is exactly 8 characters, so a
// correct implementation returns it whole. Raw-input truncation cuts at 8 raw
// characters ("hi!!! th") whatever it does with the partial word, losing a word
// the slug had room for.
await checkFn('slug that fits is kept whole even when the raw input is longer: "hi!!! there" @8 -> "hi-there"', () => {
  return slugify("hi!!! there", { maxLength: 8 }) === "hi-there";
});
await checkFn("without the option behavior is unchanged", () => {
  return slugify("hello world") === "hello-world";
});

done();
