import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PipelineConfig, Verdict } from "./types.js";
import { runPhase } from "./util.js";

/**
 * Implements the plan. Started fresh each call (no `resume`), so a fix-up
 * round after a failed judge sees the plan and the specific gaps -- not the
 * previous attempt's reasoning or self-justification for what it did. The
 * plan text is passed in by the orchestrator rather than re-read from disk,
 * so the contract can't drift mid-run.
 */
export async function runExecute(cfg: PipelineConfig, plan: string, priorVerdict?: Verdict): Promise<void> {
  const fixupNote = priorVerdict
    ? [
        "",
        "The previous attempt did not pass review. Fix these specific gaps --",
        "do not restart from scratch and do not touch anything outside them:",
        ...priorVerdict.gaps.map((g) => `- [${g.requirement}] ${g.issue}`),
      ].join("\n")
    : "";

  const prompt = `
Implement the plan below exactly as written.

<plan>
${plan}
</plan>
${fixupNote}

Rules:
- Run each step's acceptance-criterion command as you finish that step. Do not
  move on to the next step if it fails, and do not report the task done until
  every criterion has actually been run and passed.
- Leave every change uncommitted in the working tree: do not run git add,
  git commit, git stash, git checkout, or create branches. A separate review
  phase inspects the working tree.
- Do not create or modify ${cfg.planFile} -- it belongs to the pipeline.
- Stay within the plan's scope. If the plan turns out to be wrong about the
  code, satisfy its intent as closely as possible; do not invent new scope.
`.trim();

  const stream = query({
    prompt,
    options: {
      model: cfg.executeModel ?? cfg.model,
      cwd: cfg.cwd,
      permissionMode: "acceptEdits",
      allowedTools: cfg.executeAllowedTools,
      settingSources: cfg.settingSources,
      maxTurns: cfg.maxTurns.execute,
    },
  });

  await runPhase(stream, { label: "execute", verbose: true });
}
