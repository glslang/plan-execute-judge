import { query } from "@anthropic-ai/claude-agent-sdk";
import { effectiveModel, pipelineArtifactFiles, type PipelineConfig, type Verdict } from "./types.js";
import { runPhase } from "./util.js";
import { executeBashHook } from "./permissions.js";
import { serializePromptData } from "./prompt.js";
import { renderPrompt } from "./prompts.js";
import { runCodexPhase } from "./codex.js";

/**
 * Implements the plan. Started fresh each call (no `resume`), so a fix-up
 * round after a failed judge sees the plan and the specific gaps -- not the
 * previous attempt's reasoning or self-justification for what it did. The
 * plan text is passed in by the orchestrator rather than re-read from disk,
 * so the contract can't drift mid-run.
 */
export async function runExecute(cfg: PipelineConfig, plan: string, priorVerdict?: Verdict): Promise<void> {
  const inputData = serializePromptData({
    plan,
    priorGaps: priorVerdict?.gaps ?? [],
    pipelineFiles: pipelineArtifactFiles(cfg),
  });

  const prompt = renderPrompt(cfg.prompts.execute, { inputData });

  if (cfg.backend === "codex") {
    await runCodexPhase({
      label: "execute",
      prompt,
      model: effectiveModel(cfg, cfg.backend, cfg.executeModel),
      effort: cfg.effort,
      cwd: cfg.cwd,
      sandboxMode: "workspace-write",
      timeoutMs: cfg.codexPhaseTimeoutMs,
      verbose: true,
    });
    return;
  }

  const stream = query({
    prompt,
    options: {
      model: effectiveModel(cfg, cfg.backend, cfg.executeModel),
      effort: cfg.effort,
      cwd: cfg.cwd,
      permissionMode: "acceptEdits",
      allowedTools: cfg.executeAllowedTools,
      settingSources: cfg.settingSources,
      maxTurns: cfg.maxTurns.execute,
      hooks: { PreToolUse: executeBashHook("execute") },
    },
  });

  await runPhase(stream, { label: "execute", verbose: true });
}
