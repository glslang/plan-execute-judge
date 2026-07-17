import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, checkFn, done, fixtureTestsStillPass, runNode } from "./_util.mjs";

fixtureTestsStillPass({ baselineTests: 4 });

const dir = mkdtempSync(join(tmpdir(), "kv-json-check-"));
const env = { KV_FILE: join(dir, "kv.json") };
try {
  const empty = runNode(["cli.js", "list", "--json"], env);
  await checkFn("list --json on an empty store prints {}", () => {
    return empty.status === 0 && JSON.stringify(JSON.parse(empty.stdout)) === "{}";
  });

  runNode(["cli.js", "set", "a", "1"], env);
  runNode(["cli.js", "set", "b", "2"], env);

  const full = runNode(["cli.js", "list", "--json"], env);
  await checkFn("list --json prints the whole store as one JSON object", () => {
    const parsed = JSON.parse(full.stdout);
    return full.status === 0 && parsed.a === "1" && parsed.b === "2" && Object.keys(parsed).length === 2;
  });

  const plain = runNode(["cli.js", "list"], env);
  check("plain list is unchanged", plain.status === 0 && plain.stdout.trim() === "a\nb", JSON.stringify(plain.stdout));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

done();
