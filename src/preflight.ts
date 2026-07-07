import { execFileSync } from "node:child_process";

export class CliValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliValidationError";
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

export function parseMaxRounds(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined) return defaultValue;

  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliValidationError(`PEJ_MAX_ROUNDS must be a positive integer, got ${JSON.stringify(raw)}`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliValidationError(`PEJ_MAX_ROUNDS is too large, got ${JSON.stringify(raw)}`);
  }

  return parsed;
}

/**
 * Fail fast if the target isn't a git repo (the judge phase reviews git
 * diffs), capture HEAD as the judge baseline, and require committed repos to
 * start clean so pre-existing changes can't be confused with pipeline output.
 * Returns undefined for a fresh repo with no commits yet.
 */
export function gitPreflight(cwd: string): string | undefined {
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new CliValidationError(
      `Not a git repository: ${cwd}\nThe judge phase reviews git diffs. Run from inside the target repo, or set PEJ_TARGET_CWD.`
    );
  }

  let baselineRef: string;
  try {
    baselineRef = git(cwd, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    return undefined;
  }

  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    const lines = status.split(/\r?\n/);
    const excerpt = lines.slice(0, 12).join("\n");
    const suffix = lines.length > 12 ? `\n... and ${lines.length - 12} more entr${lines.length - 12 === 1 ? "y" : "ies"}` : "";
    throw new CliValidationError(
      [
        "Target repo must be clean before planning. Existing changes would be indistinguishable from pipeline output.",
        excerpt + suffix,
        "Commit, stash, or remove these changes before running plan-execute-judge.",
      ].join("\n")
    );
  }

  return baselineRef;
}
