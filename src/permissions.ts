import { normalize, sep } from "node:path";
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";

/**
 * Command vetting for guarded Bash phases.
 *
 * Plan/judge need Bash for inspection and verification, and execute needs it
 * for checks while file edits go through Write/Edit. Bash can't simply be
 * dropped from `allowedTools`, so a PreToolUse hook vets each command and
 * denies the obvious mutation vectors: git subcommands that write, file
 * manipulation commands, package-manager installs, network fetches, and output
 * redirection.
 *
 * The research phase gets a third policy: everything the read-only policy
 * allows, plus `git clone`, `curl`/`wget` downloads, and `mkdir` -- but only
 * when their destination is inside the phase's throwaway scratch directory.
 * That's what lets research ingest repos and remote PDFs without gaining any
 * way to write into the target tree.
 *
 * This is defense-in-depth, not a sandbox. A command like `node -e "..."`
 * can still write files, and quoting tricks can slip past the parser. The
 * goal is to stop the common, accidental ways an agent drifts into editing
 * the tree during review -- the same job the prompt does, but enforced.
 */

/** git subcommands that only inspect state. Everything else is denied. */
const GIT_READ_SUBCOMMANDS = new Set([
  "diff",
  "status",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "blame",
  "grep",
  "describe",
  "shortlog",
  "cat-file",
  "reflog",
  "config", // reads by default; `config key value` writes, caught below
  "version",
  "help",
]);

/** Commands whose whole purpose is to mutate the filesystem or network-fetch. */
const DENIED_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "dd",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "tee",
  "truncate",
  "shred",
  "patch",
  "install",
  "curl",
  "wget",
]);

/** Package-manager subcommands that mutate node_modules / lockfiles / site-packages. */
const DENIED_PKG_SUBCOMMANDS = new Set([
  "install",
  "i",
  "ci",
  "uninstall",
  "remove",
  "rm",
  "update",
  "upgrade",
  "add",
  "link",
  "prune",
  "dedupe",
]);
const PKG_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun", "pip", "pip3", "uv"]);

/** git options that take a separate value argument, so the value must be skipped. */
const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

export type VetResult = { ok: true } | { ok: false; reason: string };
export type BashPolicy = "read-only" | "execute" | "research";

/** True when `rawPath` normalizes to a path strictly inside `dir`. */
function isUnder(rawPath: string, dir: string): boolean {
  const p = normalize(rawPath.replace(/^['"]|['"]$/g, ""));
  const base = normalize(dir).replace(new RegExp(`\\${sep}+$`), "");
  return p.startsWith(base + sep) && p.length > base.length + 1;
}

/**
 * Research-only exceptions to the deny lists: fetch/clone/mkdir are fine as
 * long as everything they write lands inside the scratch dir. Returns
 * undefined when `cmd` isn't one of the excepted commands, so the caller
 * falls through to the normal rules.
 */
function vetResearchException(cmd: string, args: string[], scratchDir: string): VetResult | undefined {
  if (cmd === "git" && gitSubcommand(args) === "clone") {
    // Require the explicit `git clone <url> <dest>` form; without a dest,
    // git writes into the shell's cwd -- the tree under review.
    const positionals = args.slice(args.indexOf("clone") + 1).filter((t) => !t.startsWith("-"));
    if (positionals.length >= 2 && isUnder(positionals[positionals.length - 1], scratchDir)) {
      return { ok: true };
    }
    return { ok: false, reason: "`git clone` must name an explicit destination inside the research scratch dir" };
  }

  if (cmd === "curl" || cmd === "wget") {
    // curl's -O and wget's -P/default drop files into the shell's cwd, so
    // only the explicit output-file forms are allowed, and every output
    // path must be inside the scratch dir.
    const outFlags = cmd === "curl" ? ["-o", "--output"] : ["-O", "--output-document"];
    const cwdWriteFlags = cmd === "curl" ? ["-O", "--remote-name", "--remote-name-all", "--output-dir"] : ["-P", "--directory-prefix"];
    let sawOutput = false;
    for (let j = 0; j < args.length; j++) {
      const t = args[j];
      if (cwdWriteFlags.some((f) => t === f || t.startsWith(`${f}=`))) {
        return { ok: false, reason: `\`${cmd} ${t}\` writes outside the research scratch dir` };
      }
      const eqFlag = outFlags.find((f) => t.startsWith(`${f}=`));
      const value = outFlags.includes(t) ? args[++j] : eqFlag ? t.slice(eqFlag.length + 1) : undefined;
      if (value === undefined) continue;
      if (!isUnder(value, scratchDir)) {
        return { ok: false, reason: `\`${cmd}\` may only download into the research scratch dir` };
      }
      sawOutput = true;
    }
    return sawOutput
      ? { ok: true }
      : { ok: false, reason: `research allows \`${cmd}\` only with an explicit output file inside the scratch dir` };
  }

  if (cmd === "mkdir") {
    const positionals = args.filter((t) => !t.startsWith("-"));
    if (positionals.length > 0 && positionals.every((t) => isUnder(t, scratchDir))) {
      return { ok: true };
    }
    return { ok: false, reason: "`mkdir` is only allowed inside the research scratch dir" };
  }

  return undefined;
}

/**
 * Best-effort static vet of a shell command for a guarded phase.
 * Splits on `&&`, `||`, `;`, `|` and newlines, and vets each segment.
 * `scratchDir` scopes the research policy's download/clone exceptions.
 */
export function vetBashCommand(command: string, policy: BashPolicy, scratchDir?: string): VetResult {
  // Redirection writes files. Allow only the harmless forms (fd dups and
  // the null device) by stripping them first; any `>` left over is a write.
  const stripped = command
    .replace(/\d?>&\d/g, "") // 2>&1, >&2
    .replace(/\d?>>?\s*(?:\/dev\/null|NUL)\b/gi, ""); // >/dev/null, 2>/dev/null, >NUL
  if (/>/.test(stripped)) {
    return { ok: false, reason: "output redirection writes files; pipe to head/tail instead" };
  }

  for (const rawSegment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = rawSegment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    // Skip env-var prefixes (FOO=bar cmd) and `env`.
    let i = 0;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === "env")) i++;
    if (i >= tokens.length) continue;
    const cmd = tokens[i].replace(/^.*\//, ""); // basename, so /usr/bin/rm is still rm

    if (policy === "research" && scratchDir !== undefined) {
      const exception = vetResearchException(cmd, tokens.slice(i + 1), scratchDir);
      if (exception !== undefined) {
        if (!exception.ok) return exception;
        continue; // segment fully vetted by the research exception
      }
    }

    if (DENIED_COMMANDS.has(cmd)) {
      return { ok: false, reason: `\`${cmd}\` mutates the filesystem or fetches remote content` };
    }

    if (cmd === "sed" && tokens.slice(i + 1).some((t) => t === "-i" || t.startsWith("-i"))) {
      return { ok: false, reason: "`sed -i` edits files in place" };
    }

    if (cmd === "git") {
      const sub = gitSubcommand(tokens.slice(i + 1));
      if (!sub || !GIT_READ_SUBCOMMANDS.has(sub)) {
        return { ok: false, reason: `\`git ${sub ?? ""}\` can modify the repo; only read subcommands (diff, status, log, show, ...) are allowed` };
      }
      // `git config key value` writes; `git config key` / `--get` reads.
      if (sub === "config") {
        const args = tokens.slice(i + 1).filter((t) => !t.startsWith("-"));
        if (args.length > 2) return { ok: false, reason: "`git config` with a value writes configuration" };
      }
    }

    if (PKG_MANAGERS.has(cmd)) {
      const sub = tokens.slice(i + 1).find((t) => !t.startsWith("-"));
      if (sub && DENIED_PKG_SUBCOMMANDS.has(sub)) {
        return { ok: false, reason: `\`${cmd} ${sub}\` mutates dependencies; the tree under review must not change` };
      }
    }
  }

  return { ok: true };
}

export function vetReadOnlyCommand(command: string): VetResult {
  return vetBashCommand(command, "read-only");
}

export function vetExecuteCommand(command: string): VetResult {
  return vetBashCommand(command, "execute");
}

export function vetResearchCommand(command: string, scratchDir: string): VetResult {
  return vetBashCommand(command, "research", scratchDir);
}

function gitSubcommand(tokens: string[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (GIT_OPTS_WITH_VALUE.has(t)) {
      i++; // skip the option's value
      continue;
    }
    if (t.startsWith("-")) continue;
    return t;
  }
  return undefined;
}

/**
 * PreToolUse hook denying mutating Bash commands. Attach via
 * `options.hooks = { PreToolUse: readOnlyBashHook("judge") }`.
 */
function guardedBashHook(label: string, policy: BashPolicy, scratchDir?: string): HookCallbackMatcher[] {
  return [
    {
      matcher: "Bash",
      hooks: [
        async (input) => {
          if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
          const command = String((input.tool_input as { command?: unknown })?.command ?? "");
          const verdict = vetBashCommand(command, policy, scratchDir);
          if (verdict.ok) return {};
          const prefix =
            policy === "execute"
              ? `${label} allows Bash only for inspection/check commands`
              : policy === "research"
                ? `${label} may fetch sources but writes only inside its scratch dir`
                : `${label} is a read-only phase`;
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: `${prefix}: ${verdict.reason}`,
            },
          };
        },
      ],
    },
  ];
}

export function readOnlyBashHook(label: string): HookCallbackMatcher[] {
  return guardedBashHook(label, "read-only");
}

export function executeBashHook(label: string): HookCallbackMatcher[] {
  return guardedBashHook(label, "execute");
}

export function researchBashHook(label: string, scratchDir: string): HookCallbackMatcher[] {
  return guardedBashHook(label, "research", scratchDir);
}
