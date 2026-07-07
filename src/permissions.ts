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
export type BashPolicy = "read-only" | "execute";

/**
 * Best-effort static vet of a shell command for a guarded phase.
 * Splits on `&&`, `||`, `;`, `|` and newlines, and vets each segment.
 */
export function vetBashCommand(command: string, _policy: BashPolicy): VetResult {
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
function guardedBashHook(label: string, policy: BashPolicy): HookCallbackMatcher[] {
  return [
    {
      matcher: "Bash",
      hooks: [
        async (input) => {
          if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
          const command = String((input.tool_input as { command?: unknown })?.command ?? "");
          const verdict = vetBashCommand(command, policy);
          if (verdict.ok) return {};
          const prefix =
            policy === "execute"
              ? `${label} allows Bash only for inspection/check commands`
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
