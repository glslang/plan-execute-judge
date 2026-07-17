import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SandboxMode } from "@openai/codex-sdk";
import { effectiveModel, pipelineArtifactFiles, VerdictSchema, type Verdict, type PipelineConfig } from "./types.js";
import { runPhase } from "./util.js";
import { readOnlyBashHook } from "./permissions.js";
import { serializePromptData } from "./prompt.js";
import { loadPromptTemplates, renderPrompt } from "./prompts.js";
import { runCodexPhase } from "./codex.js";

// zod v4 emits a top-level "$schema" meta-key that the SDK silently rejects:
// the run succeeds but result.structured_output comes back undefined. Strip it.
const { $schema: _dropped, ...verdictJsonSchema } = z.toJSONSchema(VerdictSchema);
export { verdictJsonSchema };

export const CODEX_JUDGE_SANDBOX_MODE: SandboxMode = "workspace-write";

/**
 * Reviews the working tree against the plan and nothing else -- it never sees
 * execute's transcript or its self-report, only the plan and what's actually
 * on disk. Diffs against the baseline ref captured at startup, so changes the
 * executor staged or committed anyway are still visible, and enumerates
 * untracked files via `git status` (plain `git diff` can't see new files).
 * Bash is vetted by the same read-only hook as the plan phase. Structured
 * output turns the verdict into a real branch condition (`verdict.pass`).
 */
export async function runJudge(cfg: PipelineConfig, plan: string): Promise<Verdict> {
  const inputData = serializePromptData({
    task: cfg.task,
    plan,
    pipelineFiles: pipelineArtifactFiles(cfg),
    baselineRef: cfg.baselineRef ?? null,
    reviewCommands: {
      status: "git status --porcelain --untracked-files=all",
      diff: cfg.baselineRef ? `git diff ${cfg.baselineRef}` : "git diff",
      diffStat: cfg.baselineRef ? `git diff ${cfg.baselineRef} --stat` : "git diff --stat",
    },
  });

  const prompt = renderPrompt(loadPromptTemplates().judge, { inputData });

  if (cfg.backend === "codex") {
    const response = await runCodexPhase({
      label: "judge",
      prompt,
      model: effectiveModel(cfg, cfg.backend, cfg.judgeModel),
      effort: cfg.effort,
      cwd: cfg.cwd,
      sandboxMode: CODEX_JUDGE_SANDBOX_MODE,
      outputSchema: verdictJsonSchema,
      timeoutMs: cfg.codexPhaseTimeoutMs,
      verbose: true,
    });
    try {
      return VerdictSchema.parse(JSON.parse(response));
    } catch (err) {
      throw new Error("Codex judge returned invalid structured output", { cause: err });
    }
  }

  const stream = query({
    prompt,
    options: {
      model: effectiveModel(cfg, cfg.backend, cfg.judgeModel),
      effort: cfg.effort,
      cwd: cfg.cwd,
      permissionMode: "dontAsk",
      allowedTools: cfg.readOnlyAllowedTools,
      settingSources: cfg.settingSources,
      maxTurns: cfg.maxTurns.judge,
      hooks: { PreToolUse: readOnlyBashHook("judge") },
      outputFormat: { type: "json_schema", schema: verdictJsonSchema },
    },
  });

  const result = await runPhase(stream, { label: "judge", verbose: true });
  if (!result.structured_output) {
    throw new Error("judge phase returned success but no structured_output");
  }
  return VerdictSchema.parse(result.structured_output);
}
