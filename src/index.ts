import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { DEFAULT_CONFIG, type PipelineConfig } from "./types.js";
import { runPipeline } from "./orchestrator.js";

/**
 * Fail fast if the target isn't a git repo (the judge phase reviews git
 * diffs), and capture the current HEAD as the baseline the judge diffs
 * against. Returns undefined on a repo with no commits yet.
 */
function gitPreflight(cwd: string): string | undefined {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe" });
  } catch {
    console.error(`Not a git repository: ${cwd}`);
    console.error("The judge phase reviews git diffs. Run from inside the target repo, or set PEJ_TARGET_CWD.");
    process.exit(1);
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe" }).toString().trim();
  } catch {
    return undefined; // fresh repo, no commits yet
  }
}

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
    maxRounds: process.env.PEJ_MAX_ROUNDS ? Number(process.env.PEJ_MAX_ROUNDS) : DEFAULT_CONFIG.maxRounds,
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
  console.error(err);
  process.exit(1);
});
