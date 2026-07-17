import { checkFn, done, fixtureTestsStillPass, importFromWorktree } from "./_util.mjs";

fixtureTestsStillPass({ baselineTests: 4 });
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
await checkFn("without the option behavior is unchanged", () => {
  return slugify("hello world") === "hello-world";
});

done();
