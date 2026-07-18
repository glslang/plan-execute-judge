// Shared helpers for hidden acceptance checks. Each check script is invoked
// as `node <check>.mjs <worktree-dir>` after a pipeline run finishes, prints
// one line per assertion, and exits non-zero on any failure. Its stdout and
// stderr become optimizer feedback, so failure detail should say what was
// expected and what actually happened.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const TEST_ARGS = ["--test", "--test-reporter=tap", "test/*.test.js"];

/** Top-level passing test names from TAP output; skipped/todo tests excluded. */
function tapPassingTestNames(stdout) {
  const names = [];
  for (const line of (stdout ?? "").split("\n")) {
    const match = line.match(/^ok \d+ - (.*)$/);
    if (match && !/ # (SKIP|TODO)\b/i.test(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * Every check requires the fixture's test suite to pass, that every one of
 * the pristine fixture's tests still runs and passes by name (so a solution
 * cannot delete or skip the committed regression suite and backfill with new
 * tests), and -- since every task's contract includes "add test coverage" --
 * that the passing-test count grew beyond the pristine count. The pristine
 * names/count are derived by running the committed fixture's own suite, so
 * there is nothing to keep in sync by hand.
 *
 * The reporter is forced to TAP (newer Node versions default to the spec
 * reporter even when piped, which prints no parseable summary), and only
 * *passing* tests count, so skipped/todo stubs cannot satisfy the gate.
 */
export function fixtureTestsStillPass(fixture) {
  const pristine = spawnSync(process.execPath, TEST_ARGS, {
    cwd: join(FIXTURES_DIR, fixture),
    encoding: "utf-8",
    timeout: 120_000,
  });
  const pristineNames = tapPassingTestNames(pristine.stdout);
  check(`pristine ${fixture} fixture suite is readable`, pristine.status === 0 && pristineNames.length > 0);

  const res = runNode(TEST_ARGS);
  check(
    "fixture test suite passes",
    res.status === 0,
    `exit ${res.status}\n${(res.stdout ?? "").slice(-600)}${(res.stderr ?? "").slice(-600)}`
  );
  const passing = tapPassingTestNames(res.stdout);
  const missing = pristineNames.filter((name) => !passing.includes(name));
  check(
    `all ${pristineNames.length} original fixture tests still run and pass`,
    missing.length === 0,
    `missing or not passing: ${missing.join("; ")}`
  );
  check(
    `test coverage was added (passing tests grew beyond the ${pristineNames.length} pristine tests)`,
    passing.length > pristineNames.length,
    `suite reports ${passing.length} passing tests`
  );
}
