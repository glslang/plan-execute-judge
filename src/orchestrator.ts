import type { PipelineConfig, Verdict } from "./types.js";
import { runPlan } from "./plan.js";
import { runExecute } from "./execute.js";
import { runJudge } from "./judge.js";

export interface PipelineResult {
  passed: boolean;
  rounds: number;
  plan: string;
  finalVerdict: Verdict;
}

/**
 * The three phases as an injectable seam, so the loop below is testable
 * without the SDK, a git repo, or an API key.
 */
export interface PipelinePhases {
  plan: (cfg: PipelineConfig) => Promise<string>;
  execute: (cfg: PipelineConfig, plan: string, priorVerdict?: Verdict) => Promise<void>;
  judge: (cfg: PipelineConfig, plan: string) => Promise<Verdict>;
}

const DEFAULT_PHASES: PipelinePhases = { plan: runPlan, execute: runExecute, judge: runJudge };

export async function runPipeline(
  cfg: PipelineConfig,
  phases: PipelinePhases = DEFAULT_PHASES
): Promise<PipelineResult> {
  if (!Number.isInteger(cfg.maxRounds) || cfg.maxRounds < 1) {
    throw new Error(`maxRounds must be a positive integer, got ${cfg.maxRounds}`);
  }

  const plan = await phases.plan(cfg);
  console.log(`\n[plan] written to ${cfg.planFile}\n`);

  let verdict: Verdict | undefined;

  for (let round = 1; round <= cfg.maxRounds; round++) {
    console.log(`\n[execute] round ${round}/${cfg.maxRounds}`);
    await phases.execute(cfg, plan, verdict);

    console.log(`\n[judge] round ${round}/${cfg.maxRounds}`);
    verdict = await phases.judge(cfg, plan);
    console.log(`\n[judge] ${verdict.pass ? "PASS" : "FAIL"} -- ${verdict.summary}`);

    if (verdict.pass) {
      return { passed: true, rounds: round, plan, finalVerdict: verdict };
    }

    for (const gap of verdict.gaps) {
      console.log(`  - [${gap.requirement}] ${gap.issue}`);
    }
  }

  // verdict is always set: maxRounds >= 1 guarantees at least one judge call.
  return { passed: false, rounds: cfg.maxRounds, plan, finalVerdict: verdict! };
}
