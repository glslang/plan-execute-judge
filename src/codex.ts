import { Codex, type ModelReasoningEffort, type SandboxMode, type ThreadOptions } from "@openai/codex-sdk";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

export interface CodexPhaseOptions {
  label: string;
  prompt: string;
  model: string;
  effort: EffortLevel;
  cwd: string;
  sandboxMode: SandboxMode;
  networkAccessEnabled?: boolean;
  webSearchEnabled?: boolean;
  outputSchema?: unknown;
  verbose?: boolean;
}

export function toCodexEffort(effort: EffortLevel): ModelReasoningEffort {
  if (effort === "max") {
    throw new Error('Codex does not support effort "max"; use "xhigh" instead');
  }
  return effort;
}

export function codexThreadOptions(
  opts: Pick<
    CodexPhaseOptions,
    "model" | "effort" | "cwd" | "sandboxMode" | "networkAccessEnabled" | "webSearchEnabled"
  >
): ThreadOptions {
  return {
    model: opts.model,
    modelReasoningEffort: toCodexEffort(opts.effort),
    workingDirectory: opts.cwd,
    sandboxMode: opts.sandboxMode,
    approvalPolicy: "never",
    networkAccessEnabled: opts.networkAccessEnabled,
    webSearchEnabled: opts.webSearchEnabled,
  };
}

/** Runs one fresh, non-interactive Codex thread and returns its final response. */
export async function runCodexPhase(opts: CodexPhaseOptions): Promise<string> {
  const thread = new Codex().startThread(codexThreadOptions(opts));
  const { events } = await thread.runStreamed(opts.prompt, { outputSchema: opts.outputSchema });
  let finalResponse: string | undefined;
  let completed = false;

  for await (const event of events) {
    if (event.type === "item.completed" && event.item.type === "agent_message") {
      finalResponse = event.item.text;
      if (opts.verbose) process.stdout.write(event.item.text);
    } else if (event.type === "turn.failed") {
      throw new Error(`[${opts.label}] Codex phase failed: ${event.error.message}`);
    } else if (event.type === "error") {
      throw new Error(`[${opts.label}] Codex stream failed: ${event.message}`);
    } else if (event.type === "turn.completed") {
      completed = true;
    }
  }

  if (!completed) throw new Error(`[${opts.label}] Codex phase produced no completion event`);
  if (finalResponse === undefined) throw new Error(`[${opts.label}] Codex phase produced no final response`);
  return finalResponse;
}
