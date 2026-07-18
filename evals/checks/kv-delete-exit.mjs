import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, done, fixtureTestsStillPass, runNode } from "./_util.mjs";

fixtureTestsStillPass("kvstore");

const dir = mkdtempSync(join(tmpdir(), "kv-del-check-"));
const env = { KV_FILE: join(dir, "kv.json") };
try {
  runNode(["cli.js", "set", "a", "1"], env);

  const existing = runNode(["cli.js", "del", "a"], env);
  check("deleting an existing key exits 0", existing.status === 0, `exit ${existing.status}, stderr ${JSON.stringify(existing.stderr)}`);

  const missing = runNode(["cli.js", "del", "ghost"], env);
  check("deleting a missing key exits 1", missing.status === 1, `exit ${missing.status}`);
  check(
    "the error names the key on stderr",
    missing.stderr.includes("ghost"),
    `stderr ${JSON.stringify(missing.stderr)}`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

done();
