import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { VerdictSchema, type Verdict, type PipelineConfig } from "./types.js";
import { runPhase } from "./util.js";
import { readOnlyBashHook } from "./permissions.js";

// zod v4 emits a top-level "$schema" meta-key that the SDK silently rejects:
// the run succeeds but result.structured_output comes back undefined. Strip it.
const { $schema: _dropped, ...verdictJsonSchema } = z.toJSONSchema(VerdictSchema);
export { verdictJsonSchema };

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
  const diffCommands = cfg.baselineRef
    ? `\`git diff ${cfg.baselineRef}\` and \`git diff ${cfg.baselineRef} --stat\` (this baseline also
   catches anything that was staged or committed)`
    : "`git diff` and `git diff --stat`";

  const prompt = `
Review the current working tree against the plan below. You did not write
this code; judge it on the merits only, against what the plan actually asked
for -- not your own preferences about approach or style.

The plan was written to satisfy this task:
<task>
${cfg.task}
</task>

<plan>
${plan}
</plan>

1. Run \`git status --porcelain\` to enumerate every modified AND untracked
   file. Read the new untracked files -- a plain diff does not show them.
2. Run ${diffCommands} to see what changed.
3. For every acceptance criterion in the plan, verify it yourself by running
   the actual command it names -- do not take a comment or commit message's
   word for it.
4. Flag anything that falls outside the plan's stated scope. Ignore
   ${cfg.planFile}; it is the pipeline's own artifact, not part of the change.
5. If the implementation satisfies the plan but the plan itself missed part
   of the task, fail with a gap describing what the task still needs -- the
   plan is a means, the task is the contract.

Do not raise style preferences or alternative approaches unless they violate
a stated requirement. Each gap must be specific enough that a fresh
implementer can act on it without re-reading the whole plan.
`.trim();

  const stream = query({
    prompt,
    options: {
      model: cfg.judgeModel ?? cfg.model,
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
