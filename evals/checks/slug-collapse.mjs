import { checkFn, done, fixtureTestsStillPass, importFromWorktree } from "./_util.mjs";

fixtureTestsStillPass();
const { slugify } = await importFromWorktree("src/slugify.js");

await checkFn('consecutive spaces collapse: "hello  world" -> "hello-world"', () => {
  return slugify("hello  world") === "hello-world";
});
await checkFn("mixed whitespace runs collapse to one hyphen", () => {
  return slugify("a \t\n b") === "a-b";
});
await checkFn("leading/trailing hyphens are stripped", () => {
  return slugify(" -hello- ") === "hello";
});
await checkFn("plain input is unaffected", () => {
  return slugify("Hello World") === "hello-world";
});

done();
