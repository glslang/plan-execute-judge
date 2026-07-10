import { z } from "zod";
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";

/**
 * The judge's output. Kept intentionally narrow: a pass/fail plus a list of
 * concrete, re-actionable gaps. No free-text "review" field — that's what
 * invites style commentary and scope creep instead of a checkable verdict.
 */
export const VerdictSchema = z
  .object({
    pass: z.boolean(),
    summary: z.string().describe("One or two sentences, for a human skimming logs."),
    gaps: z
      .array(
        z.object({
          kind: z
            .enum(["implementation_gap", "plan_gap"])
            .describe(
              "implementation_gap when the implementation missed the plan/checks; plan_gap when the plan missed the task."
            ),
          requirement: z
            .string()
            .describe("The plan step, acceptance criterion, or task requirement this gap relates to."),
          issue: z
            .string()
            .describe("What's wrong, specifically enough that execute can act on it without re-reading the whole plan."),
        })
      )
      .describe("Empty when pass is true; non-empty when pass is false."),
  })
  .superRefine((verdict, ctx) => {
    if (verdict.pass && verdict.gaps.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["gaps"],
        message: "pass=true requires gaps=[]",
      });
    }
    if (!verdict.pass && verdict.gaps.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["gaps"],
        message: "pass=false requires at least one gap",
      });
    }
  });
export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * Inputs for the optional deep-research phase. The phase runs iff
 * `PipelineConfig.research` is set; its brief feeds the plan phase.
 */
export interface ResearchConfig {
  /**
   * Sources to ingest: web page URLs, git/GitHub repository URLs, and local
   * or remote document paths (PDF, markdown, ...). Remote documents and repo
   * clones land in a throwaway scratch directory, never the target tree.
   */
  sources: string[];

  /**
   * Paths to research the user has already done (notes, extracts, findings).
   * The phase treats these as trusted input to build on and verify against
   * the sources, rather than re-deriving them from scratch.
   */
  userResearch: string[];
}

export interface PipelineConfig {
  /** The task, in plain language. This drives the plan phase. */
  task: string;

  /** Working directory the agent operates in (must be a git repo for the judge's diff step). */
  cwd: string;

  /**
   * Optional deep-research step before planning. When set, the research
   * phase ingests the sources and user notes and hands the plan phase a
   * self-contained research brief. When undefined, planning starts directly.
   */
  research?: ResearchConfig;

  /** Model id used for every phase. Override per-phase below if you want a cheaper judge. */
  model: string;
  researchModel?: string;
  planModel?: string;
  executeModel?: string;
  judgeModel?: string;

  /**
   * Where the plan phase writes its output, resolved against `cwd`. This is a
   * human-readable artifact: the plan text itself crosses phase boundaries
   * in memory, so the file is never read back by the pipeline.
   */
  planFile: string;

  /**
   * Where the research phase writes its brief, resolved against `cwd`. Like
   * `planFile`, a human-readable artifact -- the brief crosses the phase
   * boundary in memory. Only written when the research phase runs.
   */
  researchFile: string;

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
  maxTurns: { research: number; plan: number; execute: number; judge: number };

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

  /**
   * Tools for the research phase: the read-only set plus web access. Its Bash
   * is vetted by a research-specific hook that additionally allows cloning
   * and downloading into a scratch directory (see permissions.ts).
   */
  researchAllowedTools: string[];
}

/**
 * Files the pipeline itself writes into the target tree -- execute must not
 * touch them and the judge ignores them. The research artifact is only
 * reserved when the research phase actually runs; otherwise a task that
 * legitimately touches a file with that name must stay in scope.
 */
export function pipelineArtifactFiles(
  cfg: Pick<PipelineConfig, "research" | "planFile" | "researchFile">
): string[] {
  return cfg.research ? [cfg.planFile, cfg.researchFile] : [cfg.planFile];
}

export const DEFAULT_CONFIG: Omit<PipelineConfig, "task" | "cwd"> = {
  model: "claude-opus-4-8",
  planFile: "PLAN.md",
  researchFile: "RESEARCH.md",
  maxRounds: 3,
  maxTurns: { research: 128, plan: 64, execute: 256, judge: 64 },
  settingSources: [],
  executeAllowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
  readOnlyAllowedTools: ["Read", "Grep", "Glob", "Bash"],
  researchAllowedTools: ["Read", "Grep", "Glob", "Bash", "WebFetch", "WebSearch"],
};
