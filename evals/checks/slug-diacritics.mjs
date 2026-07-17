import { checkFn, done, fixtureTestsStillPass, importFromWorktree } from "./_util.mjs";

fixtureTestsStillPass({ baselineTests: 4 });
const { slugify } = await importFromWorktree("src/slugify.js");

await checkFn('slugify("Café déjà vu") === "cafe-deja-vu"', () => {
  return slugify("Café déjà vu") === "cafe-deja-vu";
});
await checkFn('slugify("Über naïve") === "uber-naive"', () => {
  return slugify("Über naïve") === "uber-naive";
});
await checkFn("ASCII input is unaffected", () => {
  return slugify("Hello World") === "hello-world";
});

done();
