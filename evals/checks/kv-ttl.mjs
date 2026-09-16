import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, done, fixtureTestsStillPass, runNode } from "./_util.mjs";

// runNode merges its env over process.env, so a KV_NOW inherited from whoever
// launched this check would leak into every subprocess -- the real-clock half
// below, and the worktree's own test suite, whose added tests must be free to
// exercise the system-clock path. Drop it before anything spawns.
delete process.env.KV_NOW;

fixtureTestsStillPass("kvstore");

const dir = mkdtempSync(join(tmpdir(), "kv-ttl-check-"));

// Two stores, so the halves of this check cannot contaminate each other: keys
// stamped against the real clock read as unexpired under an injected past
// timestamp, and vice versa.
const realFile = join(dir, "real.json");
const simFile = join(dir, "sim.json");
const epochFile = join(dir, "epoch.json");

// Fixed instant for the injected-clock half. Verifying TTLs against KV_NOW
// makes the arithmetic exact -- each key is read 1ms either side of its own
// boundary, with no sleeping and no timing margin to tune. The reads straddle
// the boundary rather than land on it, so an implementation may treat expiry as
// inclusive or exclusive.
const T0 = 1_700_000_000_000;
const real = { KV_FILE: realFile };

// Simulated time must never rewind: an implementation is free to purge expired
// records when it reads, so a key observed as expired can be gone for good.
// Rewinding would demand it reappear and fail a correct purge-on-read store,
// hence the guard rather than a comment. Each store keeps its own clock.
function injectedClock(file) {
  let last = -Infinity;
  return (ms) => {
    if (ms < last) throw new Error(`check bug: KV_NOW rewound from ${last} to ${ms} on ${file}`);
    last = ms;
    return { KV_FILE: file, KV_NOW: String(ms) };
  };
}
const at = injectedClock(simFile);
const atEpoch = injectedClock(epochFile);

const lines = (res) => res.stdout.split("\n");

try {
  // ---------------------------------------------------------------- real clock
  // KV_NOW is absent here, so this half proves the store still expires against
  // the system clock: an implementation that honors only the injected clock
  // fails it.
  const set = runNode(["cli.js", "set", "temp", "v", "--ttl", "1"], real);
  check("set with --ttl exits 0", set.status === 0, set.stderr);
  // Never read via `get` before the list assertion: catches implementations
  // that lazily purge expired keys on get but leave list TTL-unaware.
  runNode(["cli.js", "set", "temp2", "v2", "--ttl", "1"], real);
  const before = runNode(["cli.js", "get", "temp"], real);
  check(
    "get before expiry returns the value",
    before.status === 0 && before.stdout.trim() === "v",
    `exit ${before.status}, stdout ${JSON.stringify(before.stdout)}`
  );

  runNode(["cli.js", "set", "keep", "stays"], real);
  // A non-unit TTL on this path too. Without it the real-clock half only ever
  // exercises --ttl 1, so an implementation could honor the seconds value under
  // KV_NOW and fall back to a constant 1s expiry without it -- passing every
  // injected boundary while `kv set x y --ttl 60` expires after a second.
  runNode(["cli.js", "set", "slow", "later", "--ttl", "30"], real);
  await new Promise((r) => setTimeout(r, 1400));

  const after = runNode(["cli.js", "get", "temp"], real);
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

  const slow = runNode(["cli.js", "get", "slow"], real);
  check(
    "system-clock --ttl 30 key is still readable once the --ttl 1 keys have expired",
    slow.status === 0 && slow.stdout.trim() === "later",
    `exit ${slow.status}, stdout ${JSON.stringify(slow.stdout)}, stderr ${JSON.stringify(slow.stderr)}`
  );

  const list = runNode(["cli.js", "list"], real);
  check("expired key is absent from list", list.status === 0 && !lines(list).includes("temp"), list.stdout);
  check("expired key never touched by get is also absent from list", !lines(list).includes("temp2"), list.stdout);
  check("system-clock --ttl 30 key is still in list", lines(list).includes("slow"), list.stdout);
  check("key without --ttl never expires", lines(list).includes("keep"), list.stdout);

  // ------------------------------------------------------------ injected clock
  // Two different TTLs, so the supplied seconds are pinned to a real duration:
  // a hardcoded expiry, or one that scales every TTL, cannot satisfy both
  // boundaries.
  const sets = [
    ["five", "v5", "--ttl", "5"],
    // five2 is never read via `get`, so the later list assertion catches a
    // store that purges expired keys on get but leaves list TTL-unaware.
    ["five2", "v5", "--ttl", "5"],
    ["sixty", "v60", "--ttl", "60"],
    ["forever", "vf"],
  ];
  const failedSet = sets
    .map((args) => [args[0], runNode(["cli.js", "set", ...args], at(T0))])
    .filter(([, res]) => res.status !== 0);
  check(
    "every set under KV_NOW exits 0",
    failedSet.length === 0,
    failedSet.map(([key, res]) => `${key}: exit ${res.status}, stderr ${JSON.stringify(res.stderr)}`).join("; ")
  );

  const fiveBefore = runNode(["cli.js", "get", "five"], at(T0 + 5_000 - 1));
  check(
    "--ttl 5 key is readable 1ms before its expiry",
    fiveBefore.status === 0 && fiveBefore.stdout.trim() === "v5",
    `exit ${fiveBefore.status}, stdout ${JSON.stringify(fiveBefore.stdout)}, stderr ${JSON.stringify(fiveBefore.stderr)}`
  );

  // Observe every key alive before asserting any of them expire, so a later
  // absence cannot be satisfied by the key never having been stored.
  const liveList = runNode(["cli.js", "list"], at(T0 + 5_000 - 1));
  check(
    "all four keys are listed before any expiry",
    liveList.status === 0 && ["five", "five2", "sixty", "forever"].every((k) => lines(liveList).includes(k)),
    `exit ${liveList.status}, stdout ${JSON.stringify(liveList.stdout)}, stderr ${JSON.stringify(liveList.stderr)}`
  );

  const fiveAfter = runNode(["cli.js", "get", "five"], at(T0 + 5_000 + 1));
  check(
    "--ttl 5 key is expired 1ms after its expiry",
    fiveAfter.status === 1 && fiveAfter.stdout.trim() === "",
    `exit ${fiveAfter.status}, stdout ${JSON.stringify(fiveAfter.stdout)}`
  );

  const sixtyEarly = runNode(["cli.js", "get", "sixty"], at(T0 + 5_000 + 1));
  check(
    "--ttl 60 key is still alive once the --ttl 5 key has expired (seconds honored per key)",
    sixtyEarly.status === 0 && sixtyEarly.stdout.trim() === "v60",
    `exit ${sixtyEarly.status}, stdout ${JSON.stringify(sixtyEarly.stdout)}, stderr ${JSON.stringify(sixtyEarly.stderr)}`
  );

  const midList = runNode(["cli.js", "list"], at(T0 + 5_000 + 1));
  check(
    "list reflects the injected clock: expired key gone, longer-lived keys still listed",
    midList.status === 0 &&
      !lines(midList).includes("five") &&
      lines(midList).includes("sixty") &&
      lines(midList).includes("forever"),
    `exit ${midList.status}, stdout ${JSON.stringify(midList.stdout)}, stderr ${JSON.stringify(midList.stderr)}`
  );
  check(
    "expired key never touched by get is also absent under the injected clock",
    !lines(midList).includes("five2"),
    midList.stdout
  );

  const sixtyBefore = runNode(["cli.js", "get", "sixty"], at(T0 + 60_000 - 1));
  check(
    "--ttl 60 key is readable 1ms before its expiry",
    sixtyBefore.status === 0 && sixtyBefore.stdout.trim() === "v60",
    `exit ${sixtyBefore.status}, stdout ${JSON.stringify(sixtyBefore.stdout)}, stderr ${JSON.stringify(sixtyBefore.stderr)}`
  );

  const sixtyAfter = runNode(["cli.js", "get", "sixty"], at(T0 + 60_000 + 1));
  check(
    "--ttl 60 key is expired 1ms after its expiry",
    sixtyAfter.status === 1 && sixtyAfter.stdout.trim() === "",
    `exit ${sixtyAfter.status}, stdout ${JSON.stringify(sixtyAfter.stdout)}`
  );

  const lateList = runNode(["cli.js", "list"], at(T0 + 60_000 + 1));
  check(
    "once both TTLs have elapsed, list keeps only the key set without --ttl",
    lateList.status === 0 && lines(lateList).filter(Boolean).join(",") === "forever",
    `exit ${lateList.status}, stdout ${JSON.stringify(lateList.stdout)}, stderr ${JSON.stringify(lateList.stderr)}`
  );
  // ------------------------------------------------------------- epoch zero
  // KV_NOW="0" is a valid instant, and it is the only place the difference
  // between reading the variable and testing it for truthiness shows:
  // `Number(process.env.KV_NOW) || Date.now()` silently reverts to the system
  // clock there, which no other assertion here would notice.
  const epochSet = runNode(["cli.js", "set", "zero", "vz", "--ttl", "5"], atEpoch(0));
  check("set with --ttl exits 0 at KV_NOW=0", epochSet.status === 0, epochSet.stderr);

  const epochBefore = runNode(["cli.js", "get", "zero"], atEpoch(5_000 - 1));
  check(
    "key set at KV_NOW=0 is readable 1ms before its expiry",
    epochBefore.status === 0 && epochBefore.stdout.trim() === "vz",
    `exit ${epochBefore.status}, stdout ${JSON.stringify(epochBefore.stdout)}, stderr ${JSON.stringify(epochBefore.stderr)}`
  );

  const epochAfter = runNode(["cli.js", "get", "zero"], atEpoch(5_000 + 1));
  check(
    "key set at KV_NOW=0 is expired 1ms after its expiry (the epoch is not treated as unset)",
    epochAfter.status === 1 && epochAfter.stdout.trim() === "",
    `exit ${epochAfter.status}, stdout ${JSON.stringify(epochAfter.stdout)}`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

done();
