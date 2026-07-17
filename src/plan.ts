import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { effectiveModel, type AgentBackend, type PipelineConfig } from "./types.js";
import { runPhase } from "./util.js";
import { readOnlyBashHook } from "./permissions.js";
import { serializePromptData } from "./prompt.js";
import { loadPromptTemplates, renderPrompt } from "./prompts.js";
import { runCodexPhase } from "./codex.js";

export interface PlanRunOptions {
  agentIndex?: number;
  agentCount?: number;
  outputFile?: string;
  backend?: AgentBackend;
}

/**
 * Read-only research + plan generation. Runs under `permissionMode:
 * "dontAsk"`, which denies any tool not in `allowedTools` instead of
 * prompting for it -- since there's no human in the loop to answer a
 * prompt in an unattended pipeline. Write/Edit are denied outright by the
 * allowlist; Bash stays available for inspection but is vetted by a
 * PreToolUse hook that denies mutating commands (see permissions.ts).
 */
export async function runPlan(cfg: PipelineConfig, research?: string, opts: PlanRunOptions = {}): Promise<string> {
  const agentIndex = opts.agentIndex ?? 1;
  const agentCount = opts.agentCount ?? 1;
  const label = agentCount > 1 ? `plan ${agentIndex}/${agentCount}` : "plan";
  const outputFile = opts.outputFile ?? cfg.planFile;
  const backend = opts.backend ?? cfg.backend;
  const inputData = serializePromptData({ task: cfg.task, research: research ?? null, agentIndex, agentCount });
  const prompt = renderPrompt(loadPromptTemplates().plan, { inputData });

  let planText: string;
  if (backend === "codex") {
    planText = await runCodexPhase({
      label,
      prompt,
      model: effectiveModel(cfg, backend, cfg.planModel),
      effort: cfg.effort,
      cwd: cfg.cwd,
      sandboxMode: "read-only",
      timeoutMs: cfg.codexPhaseTimeoutMs,
      verbose: true,
    });
  } else {
    const stream = query({
      prompt,
      options: {
        model: effectiveModel(cfg, backend, cfg.planModel),
        effort: cfg.effort,
        cwd: cfg.cwd,
        permissionMode: "dontAsk",
        allowedTools: cfg.readOnlyAllowedTools,
        settingSources: cfg.settingSources,
        maxTurns: cfg.maxTurns.plan,
        hooks: { PreToolUse: readOnlyBashHook(label) },
      },
    });
    const result = await runPhase(stream, { label, verbose: true });
    planText = result.result;
  }
  writeFileSync(resolve(cfg.cwd, outputFile), planText, "utf-8");
  return planText;
}
