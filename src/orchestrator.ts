import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  planAgentFile,
  researchAgentFile,
  type PipelineConfig,
  type Verdict,
} from "./types.js";
import { runResearch, type ResearchRunOptions } from "./research.js";
import { runPlan, type PlanRunOptions } from "./plan.js";
import { runRefinements } from "./refinements.js";
import { approvePlan } from "./approval.js";
import { runExecute } from "./execute.js";
import { runJudge } from "./judge.js";
import {
  clearPipelineState,
  loadPipelineState,
  PIPELINE_STATE_VERSION,
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
 * The phases as injectable functions, so the loop below is testable without
 * the SDK, a git repo, or an API key.
 */
export interface PipelinePhases {
  research: (cfg: PipelineConfig, opts?: ResearchRunOptions) => Promise<string>;
  plan: (cfg: PipelineConfig, research?: string, opts?: PlanRunOptions) => Promise<string>;
  refinements: (cfg: PipelineConfig, plans: string[], research?: string) => Promise<string>;
  approvePlan: (cfg: PipelineConfig, plan: string) => Promise<string>;
  execute: (cfg: PipelineConfig, plan: string, priorVerdict?: Verdict) => Promise<void>;
  judge: (cfg: PipelineConfig, plan: string) => Promise<Verdict>;
}

const DEFAULT_PHASES: PipelinePhases = {
  research: runResearch,
  plan: runPlan,
  refinements: runRefinements,
  approvePlan,
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

function phaseAfterPlan(cfg: PipelineConfig): PipelinePhase {
  return cfg.planAgents > 1 ? "refinements" : cfg.planApproval ? "approve_plan" : "execute";
}

function phaseAfterRefinements(cfg: PipelineConfig): PipelinePhase {
  return cfg.planApproval ? "approve_plan" : "execute";
}

function stateFor(
  cfg: PipelineConfig,
  phase: PipelinePhase,
  round: number,
  lastVerdict: Verdict | undefined,
  researchEnabled: boolean
): PipelineState {
  return {
    version: PIPELINE_STATE_VERSION,
    task: cfg.task,
    phase,
    round,
    baselineRef: cfg.baselineRef,
    researchEnabled,
    research: cfg.research,
    researchAgents: cfg.researchAgents,
    planAgents: cfg.planAgents,
    planApproval: cfg.planApproval,
    planFile: cfg.planFile,
    researchFile: cfg.researchFile,
    lastVerdict,
  };
}

function combineResearchBriefs(briefs: string[]): string {
  if (briefs.length === 1) return briefs[0];
  return briefs.map((brief, index) => `# Research agent ${index + 1}\n\n${brief.trim()}`).join("\n\n");
}

function readPlanCandidates(cfg: PipelineConfig): string[] {
  if (cfg.planAgents === 1) return [readResumeArtifact(cfg, cfg.planFile, "plan")];
  return Array.from({ length: cfg.planAgents }, (_, index) =>
    readResumeArtifact(cfg, planAgentFile(cfg, index + 1), `plan agent ${index + 1}`)
  );
}

async function runResearchAgents(cfg: PipelineConfig, phases: PipelinePhases): Promise<string> {
  if (!cfg.research) {
    throw new ResumeStateError("Cannot run the research phase without research inputs.");
  }

  console.log(
    `\n[research] ingesting ${cfg.research.sources.length} source(s), ${cfg.research.userResearch.length} user note(s) with ${cfg.researchAgents} agent(s)`
  );
  const briefs = await Promise.all(
    Array.from({ length: cfg.researchAgents }, (_, index) => {
      const agentIndex = index + 1;
      const outputFile = cfg.researchAgents === 1 ? cfg.researchFile : researchAgentFile(cfg, agentIndex);
      return phases.research(cfg, { agentIndex, agentCount: cfg.researchAgents, outputFile });
    })
  );
  const research = combineResearchBriefs(briefs);
  writeFileSync(resolve(cfg.cwd, cfg.researchFile), research, "utf-8");
  console.log(`\n[research] brief written to ${cfg.researchFile}\n`);
  return research;
}

async function runPlanAgents(cfg: PipelineConfig, phases: PipelinePhases, research?: string): Promise<string[]> {
  console.log(`\n[plan] running ${cfg.planAgents} planning agent(s)`);
  const plans = await Promise.all(
    Array.from({ length: cfg.planAgents }, (_, index) => {
      const agentIndex = index + 1;
      const outputFile = cfg.planAgents === 1 ? cfg.planFile : planAgentFile(cfg, agentIndex);
      return phases.plan(cfg, research, { agentIndex, agentCount: cfg.planAgents, outputFile });
    })
  );

  if (cfg.planAgents === 1) {
    console.log(`\n[plan] written to ${cfg.planFile}\n`);
  } else {
    console.log(`\n[plan] ${cfg.planAgents} candidate plans written\n`);
  }

  return plans;
}

export async function runPipeline(
  cfg: PipelineConfig,
  phases: PipelinePhases = DEFAULT_PHASES
): Promise<PipelineResult> {
  if (!Number.isInteger(cfg.maxRounds) || cfg.maxRounds < 1) {
    throw new Error(`maxRounds must be a positive integer, got ${cfg.maxRounds}`);
  }
  if (!Number.isInteger(cfg.researchAgents) || cfg.researchAgents < 1) {
    throw new Error(`researchAgents must be a positive integer, got ${cfg.researchAgents}`);
  }
  if (!Number.isInteger(cfg.planAgents) || cfg.planAgents < 1) {
    throw new Error(`planAgents must be a positive integer, got ${cfg.planAgents}`);
  }

  const savedState = cfg.resume ? loadPipelineState(cfg.cwd, cfg.stateFile) : undefined;
  if (savedState) validateResumeState(cfg, savedState);

  if (cfg.resume && !savedState) {
    throw new ResumeStateError(`Cannot resume: no ${cfg.stateFile} checkpoint found in ${cfg.cwd}.`);
  }

  const researchEnabled = savedState?.researchEnabled ?? Boolean(cfg.research || cfg.researchArtifact);
  let phase: PipelinePhase = savedState?.phase ?? initialPhase(cfg);
  let currentRound = savedState?.round ?? 1;
  let verdict = savedState?.lastVerdict;

  let research: string | undefined;
  let plan: string | undefined;
  let planCandidates: string[] | undefined;

  if (savedState) {
    console.log(`\n[resume] loaded ${cfg.stateFile}; continuing at ${phase} round ${currentRound}\n`);
  }

  if (researchEnabled && (phase === "plan" || phase === "refinements")) {
    research = readResumeArtifact(cfg, cfg.researchFile, "research");
  } else if (researchEnabled && (phase === "approve_plan" || phase === "execute" || phase === "judge")) {
    research = tryReadResumeArtifact(cfg, cfg.researchFile);
  }
  if (phase === "refinements") {
    planCandidates = readPlanCandidates(cfg);
  }
  if (phase === "approve_plan" || phase === "execute" || phase === "judge") {
    plan = readResumeArtifact(cfg, cfg.planFile, "plan");
  }

  const checkpoint = (nextPhase: PipelinePhase, nextRound: number, nextVerdict: Verdict | undefined) => {
    savePipelineState(cfg, stateFor(cfg, nextPhase, nextRound, nextVerdict, researchEnabled));
  };

  checkpoint(phase, currentRound, verdict);

  if (phase === "research") {
    research = await runResearchAgents(cfg, phases);
    phase = "plan";
    checkpoint(phase, currentRound, verdict);
  }

  if (phase === "plan") {
    planCandidates = await runPlanAgents(cfg, phases, research);
    if (cfg.planAgents === 1) {
      plan = planCandidates[0];
    }
    phase = phaseAfterPlan(cfg);
    checkpoint(phase, currentRound, verdict);
  }

  if (phase === "refinements") {
    planCandidates ??= readPlanCandidates(cfg);
    console.log(`\n[refinements] merging ${planCandidates.length} candidate plan(s)`);
    plan = await phases.refinements(cfg, planCandidates, research);
    console.log(`\n[refinements] final plan written to ${cfg.planFile}\n`);
    phase = phaseAfterRefinements(cfg);
    checkpoint(phase, currentRound, verdict);
  }

  if (phase === "approve_plan") {
    if (!plan) {
      plan = readResumeArtifact(cfg, cfg.planFile, "plan");
    }
    checkpoint("approve_plan", currentRound, verdict);
    plan = await phases.approvePlan(cfg, plan);
    writeFileSync(resolve(cfg.cwd, cfg.planFile), plan, "utf-8");
    console.log(`\n[approval] plan approved\n`);
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
