import { resolve } from "node:path";
import { DEFAULT_CONFIG, DEFAULT_MODELS, type PipelineConfig } from "./types.js";
import { runPipeline } from "./orchestrator.js";
import {
  CliValidationError,
  gitPreflight,
  parseBackend,
  parseEffort,
  parseList,
  parseMaxRounds,
  researchPreflight,
} from "./preflight.js";

async function main() {
  const task = process.argv.slice(2).join(" ");
  if (!task) {
    console.error('Usage: npm start -- "<task description>"');
    console.error("Env: PEJ_TARGET_CWD (target repo), PEJ_BACKEND, PEJ_MODEL, PEJ_EFFORT,");
    console.error("     PEJ_MAX_ROUNDS,");
    console.error("     PEJ_RESEARCH_SOURCES (urls, repos, docs -- comma-separated),");
    console.error("     PEJ_RESEARCH_NOTES (your own research files -- comma-separated)");
    process.exit(1);
  }

  const cwd = resolve(process.env.PEJ_TARGET_CWD ?? process.cwd());
  const backend = parseBackend(process.env.PEJ_BACKEND, DEFAULT_CONFIG.backend);

  const cfg: PipelineConfig = {
    ...DEFAULT_CONFIG,
    task,
    cwd,
    backend,
    research: researchPreflight(
      parseList(process.env.PEJ_RESEARCH_SOURCES),
      parseList(process.env.PEJ_RESEARCH_NOTES)
    ),
    model: process.env.PEJ_MODEL ?? DEFAULT_MODELS[backend],
    effort: parseEffort(process.env.PEJ_EFFORT, DEFAULT_CONFIG.effort),
    maxRounds: parseMaxRounds(process.env.PEJ_MAX_ROUNDS, DEFAULT_CONFIG.maxRounds),
    baselineRef: gitPreflight(cwd),
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
  if (err instanceof CliValidationError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
