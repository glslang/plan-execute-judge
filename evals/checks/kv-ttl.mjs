import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, done, fixtureTestsStillPass, runNode } from "./_util.mjs";

fixtureTestsStillPass("kvstore");

// Seconds for the bracketed key. The assertions below sit MARGIN_MS either
// side of its expiry, so both bounds tolerate process-spawn jitter: the key is
// read ~1s before it may expire and ~1s after it must have.
const MID_TTL = 4;
const MARGIN_MS = 1000;

/** Sleeps until `deadline` (ms epoch); returns immediately if already past. */
const sleepUntil = (deadline) => new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())));

const dir = mkdtempSync(join(tmpdir(), "kv-ttl-check-"));
const env = { KV_FILE: join(dir, "kv.json") };
try {
  const set = runNode(["cli.js", "set", "temp", "v", "--ttl", "1"], env);
  check("set with --ttl exits 0", set.status === 0, set.stderr);
  // Never read via `get` before the list assertion: catches implementations
  // that lazily purge expired keys on get but leave list TTL-unaware.
  runNode(["cli.js", "set", "temp2", "v2", "--ttl", "1"], env);
  // A mid TTL, bracketed on both sides of its own expiry below: this is what
  // pins the supplied seconds to a real duration. A key that only has to
  // outlive the 1s keys would also survive an implementation that scales every
  // TTL (e.g. `seconds * 500`), so `mid` must be alive well before its boundary
  // AND expired shortly after it.
  const midSetAt = Date.now();
  runNode(["cli.js", "set", "mid", "alive", "--ttl", String(MID_TTL)], env);
  // A long TTL, comfortably larger than the whole check's runtime: catches
  // implementations that ignore the supplied seconds and hardcode a short
  // (~1s) expiry for every --ttl key.
  runNode(["cli.js", "set", "long", "lives", "--ttl", "30"], env);

  const before = runNode(["cli.js", "get", "temp"], env);
  check("get before expiry returns the value", before.status === 0 && before.stdout.trim() === "v", `exit ${before.status}, stdout ${JSON.stringify(before.stdout)}`);

  runNode(["cli.js", "set", "keep", "stays"], env);
  await new Promise((r) => setTimeout(r, 1400));

  const after = runNode(["cli.js", "get", "temp"], env);
  check(
    "get after expiry behaves like a missing key (exit 1, nothing on stdout)",
    after.status === 1 && after.stdout.trim() === "",
    `exit ${after.status}, stdout ${JSON.stringify(after.stdout)}`
  );
  check(
    "expired-key error goes to stderr and names the key, like a missing key",
    after.stderr.includes("temp"),
    `stderr ${JSON.stringify(after.stderr)}`
  );

  const long = runNode(["cli.js", "get", "long"], env);
  check(
    "key set with --ttl 30 is still readable after ~1.4s (the TTL value is honored, not hardcoded)",
    long.status === 0 && long.stdout.trim() === "lives",
    `exit ${long.status}, stdout ${JSON.stringify(long.stdout)}, stderr ${JSON.stringify(long.stderr)}`
  );

  const list = runNode(["cli.js", "list"], env);
  check("expired key is absent from list", list.status === 0 && !list.stdout.split("\n").includes("temp"), list.stdout);
  check(
    "expired key never touched by get is also absent from list",
    !list.stdout.split("\n").includes("temp2"),
    list.stdout
  );
  check(
    "key set with --ttl 30 is still in list after ~1.4s",
    list.stdout.split("\n").includes("long"),
    list.stdout
  );
  check("key without --ttl never expires", list.stdout.split("\n").includes("keep"), list.stdout);

  // `mid` is set with --ttl 4: alive at ~3s, gone at ~5s. An implementation
  // that shortens every TTL fails the first assertion; one that lengthens them
  // (or never expires them) fails the second.
  await sleepUntil(midSetAt + MID_TTL * 1000 - MARGIN_MS);
  const midBefore = runNode(["cli.js", "get", "mid"], env);
  check(
    `key set with --ttl ${MID_TTL} is still readable ~1s before its expiry (TTL is not shortened)`,
    midBefore.status === 0 && midBefore.stdout.trim() === "alive",
    `exit ${midBefore.status}, stdout ${JSON.stringify(midBefore.stdout)}, stderr ${JSON.stringify(midBefore.stderr)}`
  );

  await sleepUntil(midSetAt + MID_TTL * 1000 + MARGIN_MS);
  const midAfter = runNode(["cli.js", "get", "mid"], env);
  check(
    `key set with --ttl ${MID_TTL} is expired ~1s after its expiry (TTL is not lengthened)`,
    midAfter.status === 1 && midAfter.stdout.trim() === "",
    `exit ${midAfter.status}, stdout ${JSON.stringify(midAfter.stdout)}`
  );
  const midList = runNode(["cli.js", "list"], env);
  check(
    `key set with --ttl ${MID_TTL} is absent from list once expired`,
    !midList.stdout.split("\n").includes("mid"),
    midList.stdout
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

done();
