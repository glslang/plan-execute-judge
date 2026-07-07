import { resolve } from "node:path";
import { DEFAULT_CONFIG, type PipelineConfig } from "./types.js";
import { runPipeline } from "./orchestrator.js";
import { CliValidationError, gitPreflight, parseMaxRounds } from "./preflight.js";

async function main() {
  const task = process.argv.slice(2).join(" ");
  if (!task) {
    console.error('Usage: npm start -- "<task description>"');
    console.error("Env: PEJ_TARGET_CWD (target repo), PEJ_MODEL, PEJ_MAX_ROUNDS");
    process.exit(1);
  }

  const cwd = resolve(process.env.PEJ_TARGET_CWD ?? process.cwd());

  const cfg: PipelineConfig = {
    ...DEFAULT_CONFIG,
    task,
    cwd,
    model: process.env.PEJ_MODEL ?? DEFAULT_CONFIG.model,
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
