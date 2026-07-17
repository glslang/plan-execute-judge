import { check, checkFn, done, fixtureTestsStillPass, importFromWorktree, runNode } from "./_util.mjs";

fixtureTestsStillPass({ baselineTests: 5 });
const { parse } = await importFromWorktree("src/parse.js");

await checkFn("--no-color sets flags.color to false", () => {
  const r = parse(["--no-color"]);
  return r.flags.color === false && !("no-color" in r.flags);
});
await checkFn("negation coexists with other flags and positionals", () => {
  const r = parse(["a", "--no-cache", "--name", "ada"]);
  return r.flags.cache === false && r.flags.name === "ada" && r.positionals.length === 1 && r.positionals[0] === "a";
});

const cli = runNode(["cli.js", "--no-color"]);
check("CLI exits 0 for --no-color", cli.status === 0, cli.stderr);
await checkFn("CLI reports color:false for --no-color", () => {
  return JSON.parse(cli.stdout).flags.color === false;
});

done();
