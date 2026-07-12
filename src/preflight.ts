import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { AGENT_BACKENDS, type AgentBackend, type ResearchConfig } from "./types.js";

export class CliValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliValidationError";
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

export function parsePositiveIntegerEnv(raw: string | undefined, defaultValue: number, name: string): number {
  if (raw === undefined) return defaultValue;

  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliValidationError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliValidationError(`${name} is too large, got ${JSON.stringify(raw)}`);
  }

  return parsed;
}

export function parseMaxRounds(raw: string | undefined, defaultValue: number): number {
  return parsePositiveIntegerEnv(raw, defaultValue, "PEJ_MAX_ROUNDS");
}

export function parseBooleanEnv(raw: string | undefined, defaultValue: boolean, name: string): boolean {
  if (raw === undefined) return defaultValue;

  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;

  throw new CliValidationError(`${name} must be one of 1, 0, true, false, yes, no, on, off; got ${JSON.stringify(raw)}`);
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];

function parseBackendValue(raw: string, name: string): AgentBackend {
  const value = raw.trim().toLowerCase();
  if (!AGENT_BACKENDS.some((backend) => backend === value)) {
    throw new CliValidationError(`${name} must be one of ${AGENT_BACKENDS.join(", ")}, got ${JSON.stringify(raw)}`);
  }

  return value as AgentBackend;
}

export function parseBackend(
  raw: string | undefined,
  defaultValue: AgentBackend,
  name = "PEJ_BACKEND"
): AgentBackend {
  if (raw === undefined) return defaultValue;

  return parseBackendValue(raw, name);
}

export function parseBackendList(raw: string | undefined, name: string): AgentBackend[] {
  if (raw === undefined) return [];

  const values = parseList(raw);
  if (values.length === 0) {
    throw new CliValidationError(`${name} must contain at least one backend`);
  }

  return values.map((value) => parseBackendValue(value, name));
}

export function parseEffort(raw: string | undefined, defaultValue: EffortLevel): EffortLevel {
  if (raw === undefined) return defaultValue;

  const value = raw.trim().toLowerCase();
  if (!EFFORT_LEVELS.some((level) => level === value)) {
    throw new CliValidationError(
      `PEJ_EFFORT must be one of ${EFFORT_LEVELS.join(", ")}, got ${JSON.stringify(raw)}`
    );
  }

  return value as EffortLevel;
}

/** Splits a comma-separated env value into trimmed, non-empty entries. */
export function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** URLs and scp-style git remotes (git@host:path) are fetched, not read from disk. */
function isRemote(source: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^git@[^/]+:/.test(source);
}

/**
 * Builds the research config from CLI inputs, or undefined when there is
 * nothing to research from. Local sources and user-research paths must exist
 * -- a typo'd PDF path should fail here, not after the research agent has
 * already spent turns. Local paths are resolved against `baseDir` (the
 * invocation directory, not the target repo) so relative paths mean what
 * they meant on the command line.
 */
export function researchPreflight(
  sources: string[],
  userResearch: string[],
  baseDir: string = process.cwd()
): ResearchConfig | undefined {
  if (sources.length === 0 && userResearch.length === 0) return undefined;

  // A quoted "~/notes.md" reaches us unexpanded by the shell; honor it.
  const expandTilde = (path: string) =>
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const resolveLocal = (path: string) => resolve(baseDir, expandTilde(path));
  const missing = [
    ...sources.filter((s) => !isRemote(s)).map(resolveLocal),
    ...userResearch.map(resolveLocal),
  ].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new CliValidationError(
      `Research input file(s) not found:\n${missing.map((path) => `  ${path}`).join("\n")}`
    );
  }

  return {
    sources: sources.map((s) => (isRemote(s) ? s : resolveLocal(s))),
    userResearch: userResearch.map(resolveLocal),
  };
}

/**
 * Fail fast if the target isn't a git repo (the judge phase reviews git
 * diffs), capture HEAD as the judge baseline, and require committed repos to
 * start clean so pre-existing changes can't be confused with pipeline output.
 * Returns undefined for a fresh repo with no commits yet.
 */
export function gitPreflight(cwd: string, opts: { allowDirty?: boolean } = {}): string | undefined {
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

  if (opts.allowDirty) {
    return baselineRef;
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
