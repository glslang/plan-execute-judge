import { z } from "zod";
import type { EffortLevel, SettingSource } from "@anthropic-ai/claude-agent-sdk";

export type AgentBackend = "claude" | "codex";

export const DEFAULT_MODELS: Record<AgentBackend, string> = {
  claude: "claude-opus-4-8",
  codex: "gpt-5.6-sol",
};

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
   * Resume a prior interrupted pipeline run from its checkpoint/artifacts
   * instead of requiring a clean tree and starting from research/plan again.
   */
  resume: boolean;

  /**
   * Optional deep-research step before planning. When set, the research
   * phase ingests the sources and user notes and hands the plan phase a
   * self-contained research brief. When undefined, planning starts directly.
   */
  research?: ResearchConfig;

  /**
   * True when the research artifact belongs to this pipeline run. On resume,
   * this can stay true even when the original PEJ_RESEARCH_* env vars are not
   * repeated, so execute/judge still ignore RESEARCH.md as pipeline output.
   */
  researchArtifact: boolean;

  /** Number of independent research agents to run when research is configured. */
  researchAgents: number;

  /** Number of independent planning agents to run before refinements merges their plans. */
  planAgents: number;

  /** Pause after the final plan is written and require a human approval before execute. */
  planApproval: boolean;

  /** Agent runtime used for every phase. */
  backend: AgentBackend;

  /** Model id used for every phase. Override per-phase below if you want a cheaper judge. */
  model: string;
  /** Reasoning effort used for every phase. */
  effort: EffortLevel;
  researchModel?: string;
  planModel?: string;
  refinementsModel?: string;
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

  /**
   * JSON checkpoint written between phases. Used by PEJ_RESUME=1 to skip
   * completed phases after an interrupted run.
   */
  stateFile: string;

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
   * Claude per-phase turn ceilings, so a wedged phase can't run forever. A phase
   * that hits its ceiling ends with subtype "error_max_turns", which
   * runPhase turns into a pipeline-stopping error. The Codex SDK does not
   * currently expose an equivalent per-thread turn ceiling.
   */
  maxTurns: { research: number; plan: number; refinements: number; execute: number; judge: number };

  /**
   * Which filesystem config the Claude SDK loads (CLAUDE.md, project hooks, skills).
   * Empty by default -- each phase starts from a clean slate. Set to ['project']
   * if you want the executor to see your repo's CLAUDE.md conventions.
   */
  settingSources: SettingSource[];

  /** Claude tools the execute phase may use freely (edits are auto-approved; see execute.ts). */
  executeAllowedTools: string[];

  /** Claude tools the plan/judge phases may use for read-only research and verification. */
  readOnlyAllowedTools: string[];

  /**
   * Claude tools for the research phase: the read-only set plus web access. Its Bash
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
function agentArtifactFile(file: string, index: number): string {
  const slashIndex = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const dir = slashIndex === -1 ? "" : file.slice(0, slashIndex + 1);
  const name = file.slice(slashIndex + 1);
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return `${file}.agent-${index}`;
  return `${dir}${name.slice(0, dotIndex)}.agent-${index}${name.slice(dotIndex)}`;
}

export function researchAgentFile(cfg: Pick<PipelineConfig, "researchFile">, index: number): string {
  return agentArtifactFile(cfg.researchFile, index);
}

export function planAgentFile(cfg: Pick<PipelineConfig, "planFile">, index: number): string {
  return agentArtifactFile(cfg.planFile, index);
}

export function pipelineArtifactFiles(
  cfg: Pick<
    PipelineConfig,
    "research" | "researchArtifact" | "researchAgents" | "planAgents" | "planFile" | "researchFile" | "stateFile"
  >
): string[] {
  const files = [cfg.planFile, cfg.stateFile];
  if (cfg.planAgents > 1) {
    for (let i = 1; i <= cfg.planAgents; i++) files.push(planAgentFile(cfg, i));
  }
  if (cfg.research || cfg.researchArtifact) {
    files.splice(1, 0, cfg.researchFile);
    if (cfg.researchAgents > 1) {
      for (let i = 1; i <= cfg.researchAgents; i++) files.push(researchAgentFile(cfg, i));
    }
  }
  return files;
}

export const DEFAULT_CONFIG: Omit<PipelineConfig, "task" | "cwd"> = {
  resume: false,
  backend: "claude",
  model: DEFAULT_MODELS.claude,
  effort: "high",
  researchArtifact: false,
  researchAgents: 1,
  planAgents: 1,
  planApproval: false,
  planFile: "PLAN.md",
  researchFile: "RESEARCH.md",
  stateFile: ".pej-state.json",
  maxRounds: 3,
  maxTurns: { research: 128, plan: 64, refinements: 64, execute: 256, judge: 64 },
  settingSources: [],
  executeAllowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
  readOnlyAllowedTools: ["Read", "Grep", "Glob", "Bash"],
  researchAllowedTools: ["Read", "Grep", "Glob", "Bash", "WebFetch", "WebSearch"],
};
