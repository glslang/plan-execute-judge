import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PipelineConfig, Verdict } from "./types.js";
import { runResearch } from "./research.js";
import { runPlan } from "./plan.js";
import { runExecute } from "./execute.js";
import { runJudge } from "./judge.js";
import {
  clearPipelineState,
  loadPipelineState,
  ResumeStateError,
  savePipelineState,
  type PipelinePhase,
  type PipelineState,
} from "./state.js";

export interface PipelineResult {
  passed: boolean;
  rounds: number;
  /** The research brief, present only when the research phase ran. */
  research?: string;
  plan: string;
  finalVerdict: Verdict;
}

/**
 * The phases as an injectable seam, so the loop below is testable
 * without the SDK, a git repo, or an API key. `research` only runs when
 * `cfg.research` is set; its brief is handed to `plan`.
 */
export interface PipelinePhases {
  research: (cfg: PipelineConfig) => Promise<string>;
  plan: (cfg: PipelineConfig, research?: string) => Promise<string>;
  execute: (cfg: PipelineConfig, plan: string, priorVerdict?: Verdict) => Promise<void>;
  judge: (cfg: PipelineConfig, plan: string) => Promise<Verdict>;
}

const DEFAULT_PHASES: PipelinePhases = {
  research: runResearch,
  plan: runPlan,
  execute: runExecute,
  judge: runJudge,
};

function readResumeArtifact(cfg: PipelineConfig, file: string, label: string): string {
  const path = resolve(cfg.cwd, file);
  try {
    return readFileSync(path, "utf-8");
  } catch {
    throw new ResumeStateError(
      `Cannot resume: ${label} artifact is missing at ${path}. Re-run without PEJ_RESUME, or restore the artifact.`
    );
  }
}

function tryReadResumeArtifact(cfg: PipelineConfig, file: string): string | undefined {
  const path = resolve(cfg.cwd, file);
  return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
}

function validateResumeState(cfg: PipelineConfig, state: PipelineState): void {
  if (state.task !== cfg.task) {
    throw new ResumeStateError(
      `Cannot resume: ${cfg.stateFile} was created for a different task. Re-run the same task, or run without PEJ_RESUME.`
    );
  }
  if (state.planFile !== cfg.planFile || state.researchFile !== cfg.researchFile) {
    throw new ResumeStateError(
      `Cannot resume: ${cfg.stateFile} uses different artifact paths. Re-run without PEJ_RESUME, or restore the original config.`
    );
  }
  if (state.round > cfg.maxRounds) {
    throw new ResumeStateError(
      `Cannot resume at round ${state.round}: PEJ_MAX_ROUNDS is ${cfg.maxRounds}. Increase PEJ_MAX_ROUNDS or run without PEJ_RESUME.`
    );
  }
}

function initialPhase(cfg: PipelineConfig): PipelinePhase {
  return cfg.research ? "research" : "plan";
}

function stateFor(
  cfg: PipelineConfig,
  phase: PipelinePhase,
  round: number,
  lastVerdict: Verdict | undefined,
  researchEnabled: boolean
): PipelineState {
  return {
    version: 1,
    task: cfg.task,
    phase,
    round,
    baselineRef: cfg.baselineRef,
    researchEnabled,
    research: cfg.research,
    planFile: cfg.planFile,
    researchFile: cfg.researchFile,
    lastVerdict,
  };
}

export async function runPipeline(
  cfg: PipelineConfig,
  phases: PipelinePhases = DEFAULT_PHASES
): Promise<PipelineResult> {
  if (!Number.isInteger(cfg.maxRounds) || cfg.maxRounds < 1) {
    throw new Error(`maxRounds must be a positive integer, got ${cfg.maxRounds}`);
  }

  const savedState = cfg.resume ? loadPipelineState(cfg.cwd, cfg.stateFile) : undefined;
  if (savedState) validateResumeState(cfg, savedState);

  const fallbackPlanExists = cfg.resume && !savedState && existsSync(resolve(cfg.cwd, cfg.planFile));
  const fallbackResearchExists = Boolean(
    cfg.resume && !savedState && !fallbackPlanExists && cfg.research && existsSync(resolve(cfg.cwd, cfg.researchFile))
  );
  if (cfg.resume && !savedState && !fallbackPlanExists && !fallbackResearchExists) {
    throw new ResumeStateError(
      `Cannot resume: no ${cfg.stateFile} checkpoint or ${cfg.planFile} artifact found in ${cfg.cwd}.`
    );
  }

  const researchEnabled = savedState?.researchEnabled ?? Boolean(cfg.research || cfg.researchArtifact);
  let phase: PipelinePhase =
    savedState?.phase ?? (fallbackPlanExists ? "execute" : fallbackResearchExists ? "plan" : initialPhase(cfg));
  let currentRound = savedState?.round ?? 1;
  let verdict = savedState?.lastVerdict;

  let research: string | undefined;
  let plan: string | undefined;

  if (savedState) {
    console.log(`\n[resume] loaded ${cfg.stateFile}; continuing at ${phase} round ${currentRound}\n`);
  } else if (fallbackPlanExists) {
    console.log(`\n[resume] no checkpoint found; reusing ${cfg.planFile} and continuing at execute round 1\n`);
  } else if (fallbackResearchExists) {
    console.log(`\n[resume] no checkpoint found; reusing ${cfg.researchFile} and continuing at plan\n`);
  }

  if (researchEnabled && phase === "plan") {
    research = readResumeArtifact(cfg, cfg.researchFile, "research");
  } else if (researchEnabled && (phase === "execute" || phase === "judge")) {
    research = tryReadResumeArtifact(cfg, cfg.researchFile);
  }
  if (phase === "execute" || phase === "judge") {
    plan = readResumeArtifact(cfg, cfg.planFile, "plan");
  }

  const checkpoint = (nextPhase: PipelinePhase, nextRound: number, nextVerdict: Verdict | undefined) => {
    savePipelineState(cfg, stateFor(cfg, nextPhase, nextRound, nextVerdict, researchEnabled));
  };

  checkpoint(phase, currentRound, verdict);

  if (phase === "research") {
    if (!cfg.research) {
      throw new ResumeStateError("Cannot run the research phase without research inputs.");
    }
    console.log(`\n[research] ingesting ${cfg.research.sources.length} source(s), ${cfg.research.userResearch.length} user note(s)`);
    research = await phases.research(cfg);
    console.log(`\n[research] brief written to ${cfg.researchFile}\n`);
    phase = "plan";
    checkpoint(phase, currentRound, verdict);
  }

  if (phase === "plan") {
    plan = await phases.plan(cfg, research);
    console.log(`\n[plan] written to ${cfg.planFile}\n`);
    phase = "execute";
    checkpoint(phase, currentRound, verdict);
  }

  for (; currentRound <= cfg.maxRounds; currentRound++) {
    if (!plan) {
      throw new ResumeStateError("Cannot continue pipeline without a plan artifact.");
    }

    if (phase === "execute") {
      checkpoint("execute", currentRound, verdict);
      console.log(`\n[execute] round ${currentRound}/${cfg.maxRounds}`);
      await phases.execute(cfg, plan, verdict);
      phase = "judge";
      checkpoint(phase, currentRound, verdict);
    }

    console.log(`\n[judge] round ${currentRound}/${cfg.maxRounds}`);
    verdict = await phases.judge(cfg, plan);
    console.log(`\n[judge] ${verdict.pass ? "PASS" : "FAIL"} -- ${verdict.summary}`);

    if (verdict.pass) {
      clearPipelineState(cfg);
      return { passed: true, rounds: currentRound, research, plan, finalVerdict: verdict };
    }

    for (const gap of verdict.gaps) {
      console.log(`  - [${gap.kind}: ${gap.requirement}] ${gap.issue}`);
    }

    phase = "execute";
    checkpoint(phase, currentRound + 1, verdict);
  }

  if (!plan || !verdict) {
    throw new ResumeStateError("Cannot report pipeline result without a completed judge verdict.");
  }
  return { passed: false, rounds: cfg.maxRounds, research, plan, finalVerdict: verdict };
}
