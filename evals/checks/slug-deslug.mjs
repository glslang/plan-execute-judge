import { checkFn, done, fixtureTestsStillPass, importFromWorktree } from "./_util.mjs";

fixtureTestsStillPass({ baselineTests: 4 });

await checkFn('deslugify("hello-world") === "Hello World"', async () => {
  const { deslugify } = await importFromWorktree("src/deslugify.js");
  return deslugify("hello-world") === "Hello World";
});
await checkFn('deslugify("area-51") === "Area 51"', async () => {
  const { deslugify } = await importFromWorktree("src/deslugify.js");
  return deslugify("area-51") === "Area 51";
});
await checkFn("slugify still exports and works", async () => {
  const { slugify } = await importFromWorktree("src/slugify.js");
  return slugify("Hello World") === "hello-world";
});

done();
