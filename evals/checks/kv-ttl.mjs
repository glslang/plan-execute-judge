import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, done, fixtureTestsStillPass, runNode } from "./_util.mjs";

fixtureTestsStillPass({ baselineTests: 4 });

const dir = mkdtempSync(join(tmpdir(), "kv-ttl-check-"));
const env = { KV_FILE: join(dir, "kv.json") };
try {
  const set = runNode(["cli.js", "set", "temp", "v", "--ttl", "1"], env);
  check("set with --ttl exits 0", set.status === 0, set.stderr);

  const before = runNode(["cli.js", "get", "temp"], env);
  check("get before expiry returns the value", before.status === 0 && before.stdout.trim() === "v", `exit ${before.status}, stdout ${JSON.stringify(before.stdout)}`);

  runNode(["cli.js", "set", "keep", "stays"], env);
  await new Promise((r) => setTimeout(r, 1400));

  const after = runNode(["cli.js", "get", "temp"], env);
  check("get after expiry behaves like a missing key (exit 1)", after.status === 1, `exit ${after.status}, stdout ${JSON.stringify(after.stdout)}`);
  check(
    "expired-key error goes to stderr and names the key, like a missing key",
    after.stderr.includes("temp"),
    `stderr ${JSON.stringify(after.stderr)}`
  );

  const list = runNode(["cli.js", "list"], env);
  check("expired key is absent from list", list.status === 0 && !list.stdout.split("\n").includes("temp"), list.stdout);
  check("key without --ttl never expires", list.stdout.split("\n").includes("keep"), list.stdout);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

done();
