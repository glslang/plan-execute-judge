import { z } from "zod";
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";

/**
 * The judge's output. Kept intentionally narrow: a pass/fail plus a list of
 * concrete, re-actionable gaps. No free-text "review" field — that's what
 * invites style commentary and scope creep instead of a checkable verdict.
 */
export const VerdictSchema = z.object({
  pass: z.boolean(),
  summary: z.string().describe("One or two sentences, for a human skimming logs."),
  gaps: z
    .array(
      z.object({
        requirement: z
          .string()
          .describe("The plan step or acceptance criterion this gap relates to."),
        issue: z
          .string()
          .describe("What's wrong, specifically enough that execute can act on it without re-reading the whole plan."),
      })
    )
    .describe("Empty when pass is true."),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export interface PipelineConfig {
  /** The task, in plain language. This drives the plan phase. */
  task: string;

  /** Working directory the agent operates in (must be a git repo for the judge's diff step). */
  cwd: string;

  /** Model id used for all three phases. Override per-phase below if you want a cheaper judge. */
  model: string;
  planModel?: string;
  executeModel?: string;
  judgeModel?: string;

  /**
   * Where the plan phase writes its output, resolved against `cwd`. This is a
   * human-readable artifact: the plan text itself crosses phase boundaries
   * in memory, so the file is never read back by the pipeline.
   */
  planFile: string;

  /** Max execute -> judge cycles before giving up. Must be >= 1. */
  maxRounds: number;

  /**
   * Git ref the judge diffs against (captured at startup by the CLI). Covers
   * changes the executor staged or committed despite being told not to.
   * Undefined on a repo with no commits yet -- the judge falls back to
   * `git status` + reading files.
   */
  baselineRef?: string;

  /**
   * Per-phase turn ceilings, so a wedged phase can't run forever. A phase
   * that hits its ceiling ends with subtype "error_max_turns", which
   * runPhase turns into a pipeline-stopping error.
   */
  maxTurns: { plan: number; execute: number; judge: number };

  /**
   * Which filesystem config the SDK loads (CLAUDE.md, project hooks, skills).
   * Empty by default -- each phase starts from a clean slate. Set to ['project']
   * if you want the executor to see your repo's CLAUDE.md conventions.
   */
  settingSources: SettingSource[];

  /** Tools the execute phase may use freely (edits are auto-approved in that phase; see execute.ts). */
  executeAllowedTools: string[];

  /** Tools the plan/judge phases may use for read-only research and verification. */
  readOnlyAllowedTools: string[];
}

export const DEFAULT_CONFIG: Omit<PipelineConfig, "task" | "cwd"> = {
  model: "claude-opus-4-8",
  planFile: "PLAN.md",
  maxRounds: 3,
  maxTurns: { plan: 64, execute: 256, judge: 64 },
  settingSources: [],
  executeAllowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
  readOnlyAllowedTools: ["Read", "Grep", "Glob", "Bash"],
};
