import { checkFn, done, fixtureTestsStillPass, importFromWorktree } from "./_util.mjs";

fixtureTestsStillPass({ baselineTests: 5 });
const { parse } = await importFromWorktree("src/parse.js");

await checkFn("allowed flags parse normally under allow list", () => {
  return parse(["--name", "ada"], { allow: ["name"] }).flags.name === "ada";
});
await checkFn("unknown flag under allow list throws naming the flag", () => {
  try {
    parse(["--bogus"], { allow: ["name"] });
    return false;
  } catch (err) {
    return err instanceof Error && err.message.includes("bogus");
  }
});
await checkFn("--key=value form is also validated", () => {
  try {
    parse(["--bogus=1"], { allow: ["name"] });
    return false;
  } catch (err) {
    return err instanceof Error && err.message.includes("bogus");
  }
});
await checkFn("--key value form is also validated", () => {
  try {
    parse(["--bogus", "1"], { allow: ["name"] });
    return false;
  } catch (err) {
    return err instanceof Error && err.message.includes("bogus");
  }
});
await checkFn("without the option unknown flags still parse", () => {
  return parse(["--anything"]).flags.anything === true;
});

done();
