import { checkFn, done, fixtureTestsStillPass, importFromWorktree } from "./_util.mjs";

fixtureTestsStillPass();
const { parse } = await importFromWorktree("src/parse.js");

await checkFn("repeated --key value flags collect into an array", () => {
  const tag = parse(["--tag", "a", "--tag", "b"]).flags.tag;
  return Array.isArray(tag) && tag.length === 2 && tag[0] === "a" && tag[1] === "b";
});
await checkFn("repeated --key=value flags collect into an array", () => {
  const tag = parse(["--tag=a", "--tag=b", "--tag=c"]).flags.tag;
  return Array.isArray(tag) && tag.join(",") === "a,b,c";
});
await checkFn("mixed forms collect in order", () => {
  const tag = parse(["--tag=a", "--tag", "b"]).flags.tag;
  return Array.isArray(tag) && tag.join(",") === "a,b";
});
await checkFn("single occurrence stays a plain value", () => {
  return parse(["--tag", "a"]).flags.tag === "a";
});

done();
