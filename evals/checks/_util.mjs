// Shared helpers for hidden acceptance checks. Each check script is invoked
// as `node <check>.mjs <worktree-dir>` after a pipeline run finishes, prints
// one line per assertion, and exits non-zero on any failure. Its stdout and
// stderr become optimizer feedback, so failure detail should say what was
// expected and what actually happened.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const worktree = process.argv[2];
if (!worktree) {
  console.error("usage: node <check>.mjs <worktree-dir>");
  process.exit(2);
}

let failures = 0;

export function check(name, ok, detail = "") {
  if (ok) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
  }
}

/** check() with exception capture; fn may be async and returns truthy on pass. */
export async function checkFn(name, fn) {
  try {
    check(name, Boolean(await fn()));
  } catch (err) {
    check(name, false, String(err));
  }
}

export function done() {
  process.exit(failures ? 1 : 0);
}

/** Runs `node <args>` inside the worktree (e.g. a fixture CLI). */
export function runNode(args, env = {}) {
  return spawnSync(process.execPath, args, {
    cwd: worktree,
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
}

export function importFromWorktree(relPath) {
  return import(pathToFileURL(join(worktree, relPath)).href);
}

/** Every check also requires the fixture's own committed test suite to pass. */
export function fixtureTestsStillPass() {
  const res = runNode(["--test", "test/*.test.js"]);
  check(
    "fixture test suite passes",
    res.status === 0,
    `exit ${res.status}\n${(res.stdout ?? "").slice(-600)}${(res.stderr ?? "").slice(-600)}`
  );
}
