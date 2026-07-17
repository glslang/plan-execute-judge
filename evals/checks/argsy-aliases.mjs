import { checkFn, done, fixtureTestsStillPass, importFromWorktree } from "./_util.mjs";

fixtureTestsStillPass();
const { parse } = await importFromWorktree("src/parse.js");

await checkFn("-v with alias behaves like bare --verbose", () => {
  return parse(["-v"], { aliases: { v: "verbose" } }).flags.verbose === true;
});
await checkFn("-n value with alias behaves like --name value", () => {
  return parse(["-n", "ada"], { aliases: { n: "name" } }).flags.name === "ada";
});
await checkFn("unaliased single-dash argument stays a positional", () => {
  const r = parse(["-x"], { aliases: { v: "verbose" } });
  return r.positionals.length === 1 && r.positionals[0] === "-x" && !("x" in r.flags);
});
await checkFn("long flags still work when aliases are supplied", () => {
  return parse(["--verbose"], { aliases: { v: "verbose" } }).flags.verbose === true;
});
await checkFn("calls without options keep current behavior", () => {
  const r = parse(["-x", "--name", "ada"]);
  return r.flags.name === "ada" && r.positionals[0] === "-x";
});

done();
