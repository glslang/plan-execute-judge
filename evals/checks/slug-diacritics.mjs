import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { check, checkFn, done, fixtureTestsStillPass, importFromWorktree, worktree } from "./_util.mjs";

fixtureTestsStillPass("slugger");
const { slugify } = await importFromWorktree("src/slugify.js");

await checkFn('slugify("Café déjà vu") === "cafe-deja-vu"', () => {
  return slugify("Café déjà vu") === "cafe-deja-vu";
});
await checkFn('slugify("Über naïve") === "uber-naive"', () => {
  return slugify("Über naïve") === "uber-naive";
});
// Breadth a hand-written lookup table is unlikely to cover; NFD handles all
// of these for free (deliberately avoids ł/ø/æ, which have no decomposition).
await checkFn("handles diacritics across scripts, not just the examples", () => {
  return (
    slugify("Señorita Ñandú") === "senorita-nandu" &&
    slugify("čaj šálek žár") === "caj-salek-zar" &&
    slugify("crème brûlée à ā ē ī õ ř ś ý") === "creme-brulee-a-a-e-i-o-r-s-y"
  );
});
// The task contract explicitly requires Unicode normalization rather than a
// character table -- enforce the technique, not just the behavior. Scan src/
// recursively so a solution that factors the stripping into a helper module
// is not false-failed.
await checkFn("implementation uses Unicode normalization (String.normalize)", () => {
  const srcDir = join(worktree, "src");
  return readdirSync(srcDir, { recursive: true })
    .filter((f) => String(f).endsWith(".js"))
    .some((f) => /\.normalize\s*\(/.test(readFileSync(join(srcDir, String(f)), "utf-8")));
});
await checkFn("ASCII input is unaffected", () => {
  return slugify("Hello World") === "hello-world";
});

done();
