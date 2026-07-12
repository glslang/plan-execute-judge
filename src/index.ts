import { resolve } from "node:path";
import { DEFAULT_CONFIG, DEFAULT_MODELS, type PipelineConfig } from "./types.js";
import { runPipeline } from "./orchestrator.js";
import {
  CliValidationError,
  gitPreflight,
  parseBackend,
  parseBackendList,
  parseBooleanEnv,
  parseEffort,
  parseList,
  parseMaxRounds,
  parsePositiveIntegerEnv,
  researchPreflight,
} from "./preflight.js";
import { loadPipelineState, ResumeStateError } from "./state.js";
import { PlanApprovalError } from "./approval.js";

async function main() {
  const task = process.argv.slice(2).join(" ");
  if (!task) {
    console.error('Usage: npm start -- "<task description>"');
    console.error("Env: PEJ_TARGET_CWD (target repo), PEJ_BACKEND, PEJ_MODEL, PEJ_EFFORT, PEJ_RESUME,");
    console.error("     PEJ_MAX_ROUNDS, PEJ_CODEX_TIMEOUT_MS, PEJ_RESEARCH_AGENTS, PEJ_PLAN_AGENTS, PEJ_PLAN_APPROVAL,");
    console.error("     PEJ_RESEARCH_BACKENDS, PEJ_PLAN_BACKENDS,");
    console.error("     PEJ_RESEARCH_SOURCES (urls, repos, docs -- comma-separated),");
    console.error("     PEJ_RESEARCH_NOTES (your own research files -- comma-separated)");
    process.exit(1);
  }

  const cwd = resolve(process.env.PEJ_TARGET_CWD ?? process.cwd());
  const resume = parseBooleanEnv(process.env.PEJ_RESUME, DEFAULT_CONFIG.resume, "PEJ_RESUME");
  const savedState = resume ? loadPipelineState(cwd, DEFAULT_CONFIG.stateFile) : undefined;
  if (resume && !savedState) {
    throw new CliValidationError(
      `Cannot resume: no checkpoint found at ${DEFAULT_CONFIG.stateFile}. Re-run without PEJ_RESUME to start fresh.`
    );
  }
  const backend = savedState?.backend ?? parseBackend(process.env.PEJ_BACKEND, DEFAULT_CONFIG.backend);
  const research =
    savedState?.research ??
    researchPreflight(parseList(process.env.PEJ_RESEARCH_SOURCES), parseList(process.env.PEJ_RESEARCH_NOTES));
  const currentBaselineRef = gitPreflight(cwd, { allowDirty: Boolean(savedState) });
  const baselineRef = savedState ? savedState.baselineRef : currentBaselineRef;
  const researchBackends =
    savedState?.researchBackends ?? parseBackendList(process.env.PEJ_RESEARCH_BACKENDS, "PEJ_RESEARCH_BACKENDS");
  const planBackends = savedState?.planBackends ?? parseBackendList(process.env.PEJ_PLAN_BACKENDS, "PEJ_PLAN_BACKENDS");
  const researchAgents =
    savedState?.researchAgents ??
    parsePositiveIntegerEnv(
      process.env.PEJ_RESEARCH_AGENTS,
      Math.max(DEFAULT_CONFIG.researchAgents, researchBackends.length),
      "PEJ_RESEARCH_AGENTS"
    );
  const planAgents =
    savedState?.planAgents ??
    parsePositiveIntegerEnv(
      process.env.PEJ_PLAN_AGENTS,
      Math.max(DEFAULT_CONFIG.planAgents, planBackends.length),
      "PEJ_PLAN_AGENTS"
    );
  const planApproval =
    savedState?.planApproval ??
    parseBooleanEnv(process.env.PEJ_PLAN_APPROVAL, DEFAULT_CONFIG.planApproval, "PEJ_PLAN_APPROVAL");
  const codexPhaseTimeoutMs = parsePositiveIntegerEnv(
    process.env.PEJ_CODEX_TIMEOUT_MS,
    DEFAULT_CONFIG.codexPhaseTimeoutMs,
    "PEJ_CODEX_TIMEOUT_MS"
  );
  const model = savedState?.model ?? process.env.PEJ_MODEL ?? DEFAULT_MODELS[backend];
  const modelExplicit = savedState?.modelExplicit ?? (process.env.PEJ_MODEL !== undefined);

  const cfg: PipelineConfig = {
    ...DEFAULT_CONFIG,
    task,
    cwd,
    resume,
    backend,
    research,
    researchArtifact: savedState ? savedState.researchEnabled : Boolean(research),
    researchAgents,
    researchBackends,
    planAgents,
    planBackends,
    planApproval,
    codexPhaseTimeoutMs,
    model,
    modelExplicit,
    effort: parseEffort(process.env.PEJ_EFFORT, DEFAULT_CONFIG.effort),
    maxRounds: parseMaxRounds(process.env.PEJ_MAX_ROUNDS, DEFAULT_CONFIG.maxRounds),
    baselineRef,
  };

  const result = await runPipeline(cfg);

  if (!result.passed) {
    console.error(`\nGave up after ${result.rounds} rounds. Last verdict:`);
    console.error(result.finalVerdict.summary);
    process.exit(1);
  }

  console.log(`\nDone in ${result.rounds} round(s).`);
}

main().catch((err) => {
  if (err instanceof CliValidationError || err instanceof ResumeStateError || err instanceof PlanApprovalError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
