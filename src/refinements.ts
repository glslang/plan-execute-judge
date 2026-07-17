import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { effectiveModel, type PipelineConfig } from "./types.js";
import { runPhase } from "./util.js";
import { readOnlyBashHook } from "./permissions.js";
import { serializePromptData } from "./prompt.js";
import { renderPrompt } from "./prompts.js";
import { runCodexPhase } from "./codex.js";

export async function runRefinements(cfg: PipelineConfig, plans: string[], research?: string): Promise<string> {
  if (plans.length === 0) {
    throw new Error("runRefinements called without candidate plans");
  }

  const inputData = serializePromptData({
    task: cfg.task,
    research: research ?? null,
    plans: plans.map((plan, index) => ({ agent: index + 1, plan })),
  });

  const prompt = renderPrompt(cfg.prompts.refinements, { inputData });

  let planText: string;
  if (cfg.backend === "codex") {
    planText = await runCodexPhase({
      label: "refinements",
      prompt,
      model: effectiveModel(cfg, cfg.backend, cfg.refinementsModel ?? cfg.planModel),
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
        model: effectiveModel(cfg, cfg.backend, cfg.refinementsModel ?? cfg.planModel),
        effort: cfg.effort,
        cwd: cfg.cwd,
        permissionMode: "dontAsk",
        allowedTools: cfg.readOnlyAllowedTools,
        settingSources: cfg.settingSources,
        maxTurns: cfg.maxTurns.refinements,
        hooks: { PreToolUse: readOnlyBashHook("refinements") },
      },
    });
    const result = await runPhase(stream, { label: "refinements", verbose: true });
    planText = result.result;
  }

  writeFileSync(resolve(cfg.cwd, cfg.planFile), planText, "utf-8");
  return planText;
}
