import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, done, fixtureTestsStillPass, runNode } from "./_util.mjs";

fixtureTestsStillPass("kvstore");

const dir = mkdtempSync(join(tmpdir(), "kv-prefix-check-"));
const env = { KV_FILE: join(dir, "kv.json") };
try {
  runNode(["cli.js", "set", "foo.a", "1"], env);
  runNode(["cli.js", "set", "foo.b", "2"], env);
  // Non-dotted match: "foobar" starts with "foo", so plain startsWith
  // semantics must include it (catches a startsWith(prefix + ".") cheat).
  runNode(["cli.js", "set", "foobar", "3"], env);
  runNode(["cli.js", "set", "bar", "4"], env);

  const filtered = runNode(["cli.js", "list", "--prefix", "foo"], env);
  check(
    "list --prefix foo prints every key starting with foo, sorted",
    filtered.status === 0 && filtered.stdout.trim() === "foo.a\nfoo.b\nfoobar",
    `exit ${filtered.status}, stdout ${JSON.stringify(filtered.stdout)}`
  );

  const all = runNode(["cli.js", "list"], env);
  check(
    "plain list is unchanged",
    all.status === 0 && all.stdout.trim() === "bar\nfoo.a\nfoo.b\nfoobar",
    `exit ${all.status}, stdout ${JSON.stringify(all.stdout)}`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

done();
