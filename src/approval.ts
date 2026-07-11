import { readFileSync, writeFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import type { PipelineConfig } from "./types.js";

export class PlanApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanApprovalError";
  }
}

export async function approvePlan(cfg: PipelineConfig, plan: string): Promise<string> {
  const path = resolve(cfg.cwd, cfg.planFile);
  writeFileSync(path, plan, "utf-8");

  console.log(`\n[approval] Review ${cfg.planFile}. Edit it now if needed, then type "yes" to continue.`);
  console.log("\n--- plan ---\n");
  console.log(plan);
  console.log("\n--- end plan ---\n");

  if (!input.isTTY) {
    throw new PlanApprovalError("PEJ_PLAN_APPROVAL requires interactive stdin so a human can approve the plan.");
  }

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question('Approve plan? Type "yes" to continue: ')).trim().toLowerCase();
    if (answer !== "yes" && answer !== "y") {
      throw new PlanApprovalError("Plan approval declined.");
    }
  } finally {
    rl.close();
  }

  return readFileSync(path, "utf-8");
}

