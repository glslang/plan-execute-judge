import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { CliValidationError, gitPreflight, parseList, parseMaxRounds, researchPreflight } from "./preflight.js";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pej-"));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

function throwsCliValidation(fn: () => unknown): CliValidationError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CliValidationError);
    return err;
  }
  assert.fail("expected CliValidationError");
}

function makeRepo(opts: { commit?: boolean } = {}): string {
  const dir = makeTempDir();
  git(dir, ["init"]);

  if (opts.commit !== false) {
    writeFileSync(join(dir, "file.txt"), "base\n", "utf-8");
    git(dir, ["add", "file.txt"]);
    git(dir, ["-c", "user.name=PEJ Test", "-c", "user.email=pej@example.com", "commit", "-m", "init"]);
  }

  return dir;
}

test("parseMaxRounds accepts valid integers and defaults missing values", () => {
  assert.equal(parseMaxRounds(undefined, 3), 3);
  assert.equal(parseMaxRounds("1", 3), 1);
  assert.equal(parseMaxRounds(" 12 ", 3), 12);
});

test("parseMaxRounds rejects invalid values before the pipeline starts", () => {
  for (const raw of ["", " ", "0", "-1", "1.5", "NaN", "Infinity", "abc", "1e2"]) {
    assert.throws(() => parseMaxRounds(raw, 3), CliValidationError, `expected ${JSON.stringify(raw)} to be rejected`);
  }
});

test("parseList splits comma-separated values and drops empty entries", () => {
  assert.deepEqual(parseList(undefined), []);
  assert.deepEqual(parseList(""), []);
  assert.deepEqual(parseList(" , ,"), []);
  assert.deepEqual(parseList("https://a.com, docs/spec.pdf ,git@github.com:a/b.git"), [
    "https://a.com",
    "docs/spec.pdf",
    "git@github.com:a/b.git",
  ]);
});

test("researchPreflight returns undefined when there is nothing to research", () => {
  assert.equal(researchPreflight([], []), undefined);
});

test("researchPreflight passes remote sources through and resolves local ones", () => {
  const dir = makeTempDir();
  writeFileSync(join(dir, "spec.pdf"), "%PDF-1.4\n", "utf-8");
  writeFileSync(join(dir, "notes.md"), "my findings\n", "utf-8");

  const cfg = researchPreflight(
    ["https://example.com/docs", "git@github.com:a/b.git", "spec.pdf"],
    ["notes.md"],
    dir
  );

  assert.deepEqual(cfg, {
    sources: ["https://example.com/docs", "git@github.com:a/b.git", join(dir, "spec.pdf")],
    userResearch: [join(dir, "notes.md")],
  });
});

test("researchPreflight rejects missing local sources and notes", () => {
  const dir = makeTempDir();
  const err = throwsCliValidation(() => researchPreflight(["missing.pdf"], [], dir));
  assert.match(err.message, /Research input file\(s\) not found/);
  assert.match(err.message, /missing\.pdf/);

  const err2 = throwsCliValidation(() => researchPreflight([], ["gone-notes.md"], dir));
  assert.match(err2.message, /gone-notes\.md/);
});

test("gitPreflight returns HEAD for a clean committed repo", () => {
  const dir = makeRepo();
  assert.equal(gitPreflight(dir), git(dir, ["rev-parse", "--verify", "HEAD"]));
});

test("gitPreflight rejects a dirty tracked file with a status excerpt", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "file.txt"), "changed\n", "utf-8");

  const err = throwsCliValidation(() => gitPreflight(dir));
  assert.match(err.message, /Target repo must be clean/);
  assert.match(err.message, /M file\.txt/);
});

test("gitPreflight rejects a dirty untracked file with a status excerpt", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "untracked.txt"), "new\n", "utf-8");

  const err = throwsCliValidation(() => gitPreflight(dir));
  assert.match(err.message, /Target repo must be clean/);
  assert.match(err.message, /\?\? untracked\.txt/);
});

test("gitPreflight skips the clean-tree check for a repo with no HEAD", () => {
  const dir = makeRepo({ commit: false });
  writeFileSync(join(dir, "untracked.txt"), "new\n", "utf-8");

  assert.equal(gitPreflight(dir), undefined);
});

test("gitPreflight rejects non-git directories", () => {
  const dir = makeTempDir();
  const err = throwsCliValidation(() => gitPreflight(dir));
  assert.match(err.message, /Not a git repository/);
});
